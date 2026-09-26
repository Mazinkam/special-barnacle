# Orchestration Economics Program — Implementation Plan

**Status: in-progress.** Phase A (tiers, vendor profiles, triage-sized delegating lead, spend cap,
codex->Bedrock fallback, BLOCKED outcome, lead waves) merged into `main` (`c553bf4`). Phase B
(parent-owned recon fan-out) and parts of Phase D (spend cap, provider fallback) have also landed
separately (see `feat(orchestrator): dispatch recon before leads` and
`feat(bridge): per-dispatch spend cap`). Phase E (evidence and pricing — re-measuring ROI on
matched cohorts) is not yet done; `SKILL.md`'s Performance evidence section still calls the prior
measurement historical pending that work.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut orchestrated cost and wall time without lowering verified quality: four cost tiers, vendor profiles, a triage-sized lead that delegates, scouts first, short-lived context, provider fallback, isolated self-cleaning worktrees, and a complete evidence loop.

**Architecture:** Routing policy stays in `orchestrator/method.json` (read by Python `method.py` and the HT bridge `models.ts` through a symlink). New policy logic lands in small pure TypeScript modules next to `models.ts` (`lead-sizing.ts`, `spend-cap.ts`, `provider-fallback.ts`) with `bun test` coverage; `index.ts` only wires them in. Profiles ship as a versioned file installed by `install.sh`.

**Tech Stack:** TypeScript on Bun (`bun test`), Python ≥3.9 stdlib + pytest, git worktrees, HUMAIN Terminal extension API.

**Spec:** `docs/superpowers/specs/2026-09-24-orchestration-economics-program-design.md`

## Global Constraints

- Orchestration code requests capabilities, never model names; models appear only in profiles, `FALLBACK_ADAPTER`, and persona `model:` defaults.
- No `haiku` in any routing path: profiles, `FALLBACK_ADAPTER`, persona files, `MODEL_FAMILY_PRESETS`, SKILL.md routing tables. (Pricing rows for historical data may keep haiku.)
- No `gpt-5.6-*` model in any profile.
- Tier order is exactly `["cheap", "mid", "premium", "frontier"]`.
- `provider_preference` is exactly `["openai-codex", "amazon-bedrock"]`.
- `premium` is the active profile; no profile named `default` ships.
- Tests never read or write `~/.local/state/coding-agent-orchestrator`; use temp dirs and `CODING_AGENT_ORCHESTRATOR_HOME`.
- Worktree test runs set `HUMAIN_ORCHESTRATOR_SKILL_ROOT=<worktree path>` so HT does not import the main checkout.
- Test commands: `python3 -B -m pytest -p no:cacheprovider -q` and `bun test ./bridge`.
- Each phase runs in its own worktree `.worktrees/economics-<phase>` that is removed after the phase merges.

## Review Focus

- Triage returns complexity outside 1–10, NaN, or an unknown risk string → lead size still resolves (clamped complexity; unknown risk treated as `medium`). Pinned in Task A3.
- A profile names an alias that is not in the live registry (e.g. `opus-5-5` missing on a machine) → resolution warns and `/orchestrate` aborts before dispatch, never silently runs a lead on another tier. Pinned in Task A2.
- Codex quota error on a model with no Bedrock twin → the original failure is reported unchanged; no redispatch loop. Pinned in Task A6.
- Spend cap crossed by a single large `message_end` jump (e.g. $0 → $12) → exactly one `spend_cap_exceeded` event, and in `enforce` exactly one cancel. Pinned in Task A5.
- Worktree cleanup after a crash mid-merge → patch saved before removal; sweep never removes a worktree whose run is not terminal. Pinned in Task D2.

---

## Phase 0 — Land in-flight work

### Task 0.1: Commit the staged efficiency-and-evidence work on `main`

**Files:** everything currently staged/modified on `main` (see `git status --short`).

- [ ] **Step 1: Confirm no peer session is editing this checkout.** (2026-09-24 deviation: two peer sessions were still editing `main` and both worktrees, so Phase A was built in `.worktrees/economics-a` from the latest committed efficiency work `448347e` plus a merge of `feat/enforced-worker-topology` at `f2ddaa6`. Committing the staged work on `main` is left to the session that owns it.) Ask the user; also check recent activity:

```bash
cd ~/.local/share/agent-skills/hierarchical-agent-orchestrator
git status --short
find . -path ./.git -prune -o -path ./.worktrees -prune -o -type f -newermt '-15 minutes' -print | head
```

Expected: user confirms; no files modified in the last 15 minutes by another session.

- [ ] **Step 2: Review unstaged deltas on top of staged files** (`MM`/`AM` entries) and the two untracked files:

```bash
git diff --stat            # unstaged
git diff --cached --stat   # staged
git status --short | grep '^??'
```

Expected untracked: `docs/superpowers/plans/2026-09-23-per-turn-dashboard-sync.md`, `tests/test_merge_verification_and_sentinels.py`. Both belong to the same program; include them.

- [ ] **Step 3: Run both suites**

```bash
python3 -B -m pytest -p no:cacheprovider -q
bun test ./bridge
```

Expected: all pass. If anything fails, stop and report the failing test names to the user; do not commit.

- [ ] **Step 4: Commit**

```bash
git add -A -- . ':!linux-report.md' ':!linux-fix-report.md'
git commit -m "feat: orchestrator efficiency and evidence program (batched writes, run evidence, archive, ingest checkpoints)"
git add linux-report.md linux-fix-report.md
git commit -m "docs: linux validation reports"
```

### Task 0.2: Merge `feat/enforced-worker-topology`

**Files:** `bridge/extensions/orchestrator/{index.ts,index.test.ts,models.ts,recon.ts,recon.test.ts}`, `bridge/README.md`, spec under `docs/superpowers/specs/2026-09-23-enforced-worker-topology-design.md`.

- [ ] **Step 1: Merge**

```bash
git merge --no-ff feat/enforced-worker-topology -m "merge: enforced parent-owned recon before leads"
```

- [ ] **Step 2: Resolve conflicts.** Expected in `index.ts`/`index.test.ts`. Rules: keep `main`'s record-queue/batched `recordEvent`/`recordModelCall` plumbing and progress-aware timeouts; keep the branch's `dispatchReconAndLeads`, `collectBilledResults`, `summarizeReconWorkers`, recon-aware `leadPrompt(goal, plan, architectResult, reconEvidence, leadIndex, leadCount, adapter)`, and `dispatch-outcome.ts` recovery. `dispatchHierarchical` must call `dispatchReconAndLeads` and return `workerResults`; the final report must use `collectBilledResults`.

- [ ] **Step 3: Verify**

```bash
bun test ./bridge
python3 -B -m pytest -p no:cacheprovider -q
grep -n "workers fan out inside each lead" bridge/extensions/orchestrator/index.ts
```

Expected: tests pass; grep returns nothing.

- [ ] **Step 4: Commit the merge resolution**

```bash
git add -A && git commit --no-edit
```

### Task 0.3: Remove stale worktrees

- [ ] **Step 1: Preserve anything unmerged**

```bash
git merge-base --is-ancestor feat/enforced-worker-topology main && echo merged
git merge-base --is-ancestor 3ea6933 main && echo merged || git branch archive/orchestrator-efficiency 3ea6933
```

- [ ] **Step 2: Check both worktrees are clean, then remove**

```bash
for w in .worktrees/enforced-worker-topology .worktrees/orchestrator-efficiency; do
  git -C "$w" status --short | head -5
done
git worktree unlock .worktrees/enforced-worker-topology
git worktree unlock .worktrees/orchestrator-efficiency
git worktree remove .worktrees/enforced-worker-topology
git worktree remove .worktrees/orchestrator-efficiency
git branch -d feat/enforced-worker-topology
git worktree prune && git worktree list
```

Expected: if a worktree has uncommitted changes, stop and save them with `git -C "$w" diff > /tmp/<name>.patch` before removing. Final `git worktree list` shows only the main checkout.

---

## Phase A — Tiers, profiles, right-sized delegating lead

Setup (once):

```bash
git worktree add .worktrees/economics-a -b feat/economics-phase-a
cd .worktrees/economics-a
export HUMAIN_ORCHESTRATOR_SKILL_ROOT="$PWD"
```

### Task A1: Add the `frontier` tier and the new lead capabilities to the method

**Files:**
- Modify: `orchestrator/method.json`
- Modify: `orchestrator/method.py`
- Modify: `orchestrator/dynamic_adapter.py:62-66` (`MODEL_FAMILY_PRESETS`)
- Modify: `bridge/extensions/orchestrator/models.ts` (`Tier`, `TIERS`, `TIER_CAPABILITIES`, `isTier`, `MethodFile`)
- Test: `tests/test_method.py`, `bridge/extensions/orchestrator/models.test.ts`

**Interfaces:**
- Produces (TS): `type Tier = "cheap" | "mid" | "premium" | "frontier"`; `TIERS: Tier[] = ["frontier","premium","mid","cheap"]` (display order); `METHOD.rules.lead_sizing`, `METHOD.rules.dispatch_spend_cap` typed on `MethodFile`.
- Produces (Py): `method.lead_size(complexity: float, risk: str, override: str | None = None) -> str`; `ADAPTER_TIER_NAMES["frontier"] == "expensive"`.

- [ ] **Step 1: Write failing Python tests** — append to `tests/test_method.py` and change the tier assertion in `test_loads_and_validates`:

```python
    def test_loads_and_validates(self):
        m = method.load_method()
        self.assertEqual(m["schema_version"], 1)
        self.assertEqual(m["tiers"], ["cheap", "mid", "premium", "frontier"])

    def test_lead_capabilities_and_tiers(self):
        self.assertEqual(method.tier_of("lead_small"), "mid")
        self.assertEqual(method.tier_of("lead"), "premium")
        self.assertEqual(method.tier_of("lead_large"), "frontier")
        self.assertEqual(method.rereview_floor("critical")["tier_min"], "frontier")
        self.assertEqual(method.rereview_floor("high")["tier_min"], "premium")

    def test_lead_size(self):
        self.assertEqual(method.lead_size(2, "low"), "small")
        self.assertEqual(method.lead_size(5, "low"), "standard")
        self.assertEqual(method.lead_size(8, "low"), "large")
        self.assertEqual(method.lead_size(2, "medium"), "standard")
        self.assertEqual(method.lead_size(2, "high"), "large")
        self.assertEqual(method.lead_size(2, "critical"), "large")
        self.assertEqual(method.lead_size(99, "bogus"), "large")      # clamped to 10
        self.assertEqual(method.lead_size(-4, "bogus"), "standard")   # clamped to 1, unknown risk -> medium
        self.assertEqual(method.lead_size(9, "critical", override="small"), "small")

    def test_spend_cap_rule(self):
        cap = method.rule("dispatch_spend_cap")
        self.assertIn(cap["mode"], ("off", "warn", "enforce"))
        self.assertEqual(cap["usd_by_capability"]["lead_large"], 10.0)

    def test_no_haiku_in_family_presets(self):
        from orchestrator.dynamic_adapter import MODEL_FAMILY_PRESETS
        for preset in MODEL_FAMILY_PRESETS.values():
            for prefix in preset.values():
                self.assertNotIn("haiku", prefix)
```

- [ ] **Step 2: Run to verify they fail**

Run: `python3 -B -m pytest -p no:cacheprovider -q tests/test_method.py`
Expected: FAIL (`tiers` mismatch, `lead_small` unknown, `lead_size` missing).

- [ ] **Step 3: Edit `orchestrator/method.json`**

Set `"tiers": ["cheap", "mid", "premium", "frontier"]`. In `capabilities` add/replace:

```json
    "lead_small":            { "tier": "mid",      "default_effort": "standard" },
    "lead":                  { "tier": "premium",  "default_effort": "standard" },
    "lead_large":            { "tier": "frontier", "default_effort": "standard" },
```

In `rules.review_after_fix.escalation_by_risk.critical` set `"tier_min": "frontier"`. In `rules.review_after_fix.rationale` replace "The cheap tier confirmed 4/4 re-reviews" wording is fine as-is (tier-neutral). Add two rules:

```json
    "lead_sizing": {
      "summary": "Triage picks a lead size; profiles bind sizes to models through tiers.",
      "sizes": { "small": "lead_small", "standard": "lead", "large": "lead_large" },
      "by_complexity": [
        { "min": 1, "max": 3,  "size": "small" },
        { "min": 4, "max": 6,  "size": "standard" },
        { "min": 7, "max": 10, "size": "large" }
      ],
      "risk_floor": { "low": "small", "medium": "standard", "high": "large", "critical": "large" },
      "escalate_on_verification_failure": true,
      "rationale": "2026-09-24: fable-5-1 leads cost $90.71 over 17 runs (11 verified pass); sonnet-5 leads cost $1.04 over 21 runs (19 verified pass). Size the lead to the task and escalate on failure instead of pinning the frontier model."
    },
    "dispatch_spend_cap": {
      "summary": "Per-dispatch USD ceiling on live reported cost. warn notifies once; enforce also cancels the dispatch.",
      "mode": "warn",
      "usd_by_capability": { "lead_small": 1.5, "lead": 4.0, "lead_large": 10.0, "architect": 2.0 },
      "default_usd": 1.0
    }
```

Update the top-level `description` sentence "Runtime config (pricing, features, budgets, persistence) stays in config.json" to "Runtime config (pricing, features, persistence) stays in config.json; per-dispatch spend caps are method policy (rules.dispatch_spend_cap)".

- [ ] **Step 4: Edit `orchestrator/method.py`**

```python
ADAPTER_TIER_NAMES = {"cheap": "cheapest", "mid": "mid", "premium": "expensive", "frontier": "expensive"}

LEAD_SIZE_ORDER = ["small", "standard", "large"]


def lead_size(complexity: float, risk: str, override: str | None = None) -> str:
    """Lead sizing: max(complexity band, risk floor); a valid override wins."""
    r = rule("lead_sizing")
    if override in LEAD_SIZE_ORDER:
        return override
    try:
        c = float(complexity)
    except (TypeError, ValueError):
        c = 5.0
    if c != c:  # NaN
        c = 5.0
    c = max(1.0, min(10.0, round(c)))
    band = next((b["size"] for b in r["by_complexity"] if b["min"] <= c <= b["max"]), r["by_complexity"][-1]["size"])
    floor = r["risk_floor"].get(risk, r["risk_floor"]["medium"])
    return max(band, floor, key=LEAD_SIZE_ORDER.index)
```

Extend `_validate` so a bad size or capability fails loudly:

```python
    ls = m["rules"].get("lead_sizing")
    if ls:
        for size, cap in ls["sizes"].items():
            if cap not in m["capabilities"]:
                raise ValueError(f"method.json: lead_sizing size {size!r} maps to undeclared capability {cap!r}")
        for band in ls["by_complexity"]:
            if band["size"] not in ls["sizes"]:
                raise ValueError(f"method.json: lead_sizing band {band!r} has unknown size")
        for risk, size in ls["risk_floor"].items():
            if size not in ls["sizes"]:
                raise ValueError(f"method.json: lead_sizing risk_floor[{risk}] has unknown size {size!r}")
```

- [ ] **Step 5: Edit `orchestrator/dynamic_adapter.py` preset**

```python
MODEL_FAMILY_PRESETS: dict[str, dict[str, str]] = {
    "anthropic": {
        "cheapest":  "claude-sonnet",
        "mid":       "claude-sonnet",
        "expensive": "claude-opus",
    },
}
```

Update the comment above it: "cheapest=sonnet (haiku is not used), mid=sonnet, expensive=opus".

- [ ] **Step 6: Run Python tests**

Run: `python3 -B -m pytest -p no:cacheprovider -q`
Expected: `tests/test_method.py` passes. Any other test that asserted haiku for a routed capability (grep `rg -n "haiku" tests/test_dynamic_adapter.py tests/test_policy.py`) fails; update those expectations to `claude-sonnet` and re-run until green. Leave pricing fixtures that mention haiku unchanged.

- [ ] **Step 7: Write failing bun tests** — add to `bridge/extensions/orchestrator/models.test.ts`:

```ts
import { METHOD, TIERS, isTier, tierOf, tiersToBindings } from "./models.ts";

describe("tiers", () => {
	test("frontier is a tier and orders above premium", () => {
		expect(METHOD.tiers).toEqual(["cheap", "mid", "premium", "frontier"]);
		expect(TIERS[0]).toBe("frontier");
		expect(isTier("frontier")).toBe(true);
	});
	test("lead sizes sit on mid/premium/frontier", () => {
		expect(tierOf("lead_small")).toBe("mid");
		expect(tierOf("lead")).toBe("premium");
		expect(tierOf("lead_large")).toBe("frontier");
	});
	test("frontier tier binding reaches lead_large", () => {
		expect(tiersToBindings({ frontier: "fable-5-1" }).lead_large).toEqual({ model: "fable-5-1" });
	});
});
```

- [ ] **Step 8: Run to verify failure**

Run: `bun test ./bridge/extensions/orchestrator/models.test.ts`
Expected: FAIL (`isTier("frontier")` false; `TIER_CAPABILITIES.frontier` undefined).

- [ ] **Step 9: Edit `models.ts`**

```ts
export type Tier = "cheap" | "mid" | "premium" | "frontier";
export const TIERS: Tier[] = ["frontier", "premium", "mid", "cheap"];

export type LeadSize = "small" | "standard" | "large";

interface MethodFile {
	schema_version: number;
	tiers: Tier[];
	capabilities: Record<string, { tier: Tier; default_effort: string }>;
	effort_levels: string[];
	roles: Record<string, string>;
	rules: {
		review_after_fix: {
			prohibit_tiers: Tier[];
			escalation_by_risk: Record<RiskLevel, ReReviewFloor>;
		};
		pre_implementation_recon: {
			min_complexity: number;
			workers_by_complexity: { min: number; max: number; workers: number }[];
			worker_capability: string;
			skip_for_task_classes: string[];
		};
		lead_sizing: {
			sizes: Record<LeadSize, string>;
			by_complexity: { min: number; max: number; size: LeadSize }[];
			risk_floor: Record<string, LeadSize>;
			escalate_on_verification_failure: boolean;
		};
		dispatch_spend_cap: {
			mode: "off" | "warn" | "enforce";
			usd_by_capability: Record<string, number>;
			default_usd: number;
		};
	};
}

export const TIER_CAPABILITIES: Record<Tier, string[]> = { cheap: [], mid: [], premium: [], frontier: [] };

export function isTier(s: string): s is Tier {
	return s === "cheap" || s === "mid" || s === "premium" || s === "frontier";
}
```

Update the `parseProfileSpec` tier error text to `(cheap|mid|premium|frontier)`. `formatAdapterTable` pads tier names with `padEnd(7)`; change to `padEnd(8)` so `frontier` aligns.

- [ ] **Step 10: Run all bridge tests**

Run: `bun test ./bridge`
Expected: PASS. Fix any snapshot of `formatAdapterTable` output that changed width.

- [ ] **Step 11: Commit**

```bash
git add orchestrator/method.json orchestrator/method.py orchestrator/dynamic_adapter.py tests/ bridge/extensions/orchestrator/models.ts bridge/extensions/orchestrator/models.test.ts
git commit -m "feat(method): frontier tier, lead_small/lead/lead_large, lead_sizing and dispatch_spend_cap rules"
```

### Task A2: Vendor profiles, premium default, haiku removal

**Files:**
- Create: `bridge/orchestrator-profiles.json`
- Modify: `install.sh` (install profiles with backup)
- Modify: `bridge/extensions/orchestrator/index.ts` (`FALLBACK_ADAPTER`, `emptyProfilesFile` default name usage)
- Modify: `bridge/extensions/orchestrator/models.ts` (`emptyProfilesFile`)
- Modify: `bridge/agents/*.md` (`model:` lines)
- Test: `bridge/extensions/orchestrator/models.test.ts`

**Interfaces:**
- Consumes: `parseProfilesFile`, `mergeLayers`, `tiersToBindings`, `buildAliasTable` from `models.ts`.
- Produces: `bridge/orchestrator-profiles.json` with profiles `premium`, `anthropic`, `openai`, `oss`; `emptyProfilesFile()` returns `{ version: 1, active_profile: "premium", profiles: { premium: {} } }`.

- [ ] **Step 1: Write failing tests** — append to `models.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emptyProfilesFile } from "./models.ts";

const CATALOG: AvailableModel[] = [
	{ provider: "amazon-bedrock", id: "global.anthropic.claude-fable-5-1" },
	{ provider: "amazon-bedrock", id: "global.anthropic.claude-opus-5-5" },
	{ provider: "amazon-bedrock", id: "global.anthropic.claude-sonnet-5" },
	{ provider: "amazon-bedrock", id: "global.openai.gpt-6-astra" },
	{ provider: "amazon-bedrock", id: "global.openai.gpt-6-sol" },
	{ provider: "amazon-bedrock", id: "global.openai.gpt-6-luna" },
	{ provider: "openai-codex", id: "gpt-6-astra" },
	{ provider: "humain-node", id: "glm-5.2" },
	{ provider: "humain-node", id: "minimax-m3" },
	{ provider: "humain-node", id: "qwen3.8-27b" },
	{ provider: "humain-node", id: "kimi-k3" },
	{ provider: "humain-node", id: "humain-m3-research-preview" },
];
const PROFILES_RAW = JSON.parse(readFileSync(join(import.meta.dir, "../../orchestrator-profiles.json"), "utf-8"));

describe("shipped profiles", () => {
	const { file, problems } = parseProfilesFile(PROFILES_RAW);
	test("parse cleanly with premium active and no default profile", () => {
		expect(problems).toEqual([]);
		expect(file.active_profile).toBe("premium");
		expect(Object.keys(file.profiles).sort()).toEqual(["anthropic", "oss", "openai", "premium"]);
		expect(file.provider_preference).toEqual(["openai-codex", "amazon-bedrock"]);
	});
	test("no haiku and no gpt-5.6 anywhere", () => {
		const text = JSON.stringify(PROFILES_RAW).toLowerCase();
		expect(text).not.toContain("haiku");
		expect(text).not.toContain("gpt-5.6");
	});
	for (const name of ["premium", "anthropic", "openai", "oss"]) {
		test(`${name} resolves every capability without user-layer warnings`, () => {
			const p = file.profiles[name];
			const table = buildAliasTable(CATALOG);
			const r = mergeLayers(
				[
					{ source: `profile:${name}`, bindings: Object.fromEntries(Object.entries(p.capabilities ?? {}).map(([c, m]) => [c, { model: m }])) },
					{ source: `profile:${name}`, bindings: tiersToBindings(p.tiers) },
				],
				table, ["openai-codex", "amazon-bedrock"], p.effort ?? {},
			);
			expect(userLayerWarnings(r)).toEqual([]);
			for (const cap of ["scout", "lead_small", "lead", "lead_large", "technical_review", "security_review"]) {
				expect(r.adapter[cap]?.model).toBeDefined();
			}
		});
	}
	test("premium binds the agreed lead ladder and cross-vendor review", () => {
		const p = file.profiles.premium;
		const r = mergeLayers(
			[
				{ source: "profile:premium", bindings: Object.fromEntries(Object.entries(p.capabilities ?? {}).map(([c, m]) => [c, { model: m }])) },
				{ source: "profile:premium", bindings: tiersToBindings(p.tiers) },
			],
			buildAliasTable(CATALOG), ["openai-codex", "amazon-bedrock"], p.effort ?? {},
		);
		expect(r.adapter.scout.model).toBe("amazon-bedrock/global.openai.gpt-6-luna");
		expect(r.adapter.lead_small.model).toBe("amazon-bedrock/global.anthropic.claude-sonnet-5");
		expect(r.adapter.lead.model).toBe("amazon-bedrock/global.anthropic.claude-opus-5-5");
		expect(r.adapter.lead_large.model).toBe("amazon-bedrock/global.anthropic.claude-fable-5-1");
		expect(r.adapter.technical_review.model).toBe("amazon-bedrock/global.openai.gpt-6-sol");
		expect(r.adapter.security_review.model).toBe("openai-codex/gpt-6-astra");
	});
	test("openai premium tier is gpt-6-sol at high effort", () => {
		const p = file.profiles.openai;
		expect(p.tiers?.premium).toBe("gpt-6-sol");
		expect(p.effort?.lead).toBe("high");
		expect(p.effort?.architect).toBe("high");
	});
	test("empty profiles file defaults to premium", () => {
		expect(emptyProfilesFile().active_profile).toBe("premium");
	});
	test("an alias missing from the registry is a user-layer warning (run must abort)", () => {
		const table = buildAliasTable(CATALOG.filter((m) => !m.id.includes("opus-5-5")));
		const r = mergeLayers([{ source: "profile:premium", bindings: tiersToBindings({ premium: "opus-5-5" }) }], table, PREF);
		expect(userLayerWarnings(r).length).toBeGreaterThan(0);
		expect(r.adapter.lead).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test ./bridge/extensions/orchestrator/models.test.ts`
Expected: FAIL (file `bridge/orchestrator-profiles.json` not found).

- [ ] **Step 3: Create `bridge/orchestrator-profiles.json`**

```json
{
  "version": 1,
  "active_profile": "premium",
  "provider_preference": ["openai-codex", "amazon-bedrock"],
  "profiles": {
    "premium": {
      "description": "Mixed vendor: Luna scouts/workers, Anthropic lead ladder (sonnet-5 / opus-5-5 / fable-5-1), OpenAI gpt-6-sol reviews, astra security review.",
      "tiers": {
        "cheap": "gpt-6-luna",
        "mid": "sonnet-5",
        "premium": "opus-5-5",
        "frontier": "fable-5-1"
      },
      "capabilities": {
        "technical_review": "gpt-6-sol",
        "integration_review": "gpt-6-sol",
        "migration_review": "gpt-6-sol",
        "performance_review": "gpt-6-sol",
        "api_contract_review": "gpt-6-sol",
        "security_review": "astra"
      }
    },
    "anthropic": {
      "description": "Anthropic only. No haiku: the cheap tier is sonnet-5 at low effort.",
      "tiers": {
        "cheap": "sonnet-5",
        "mid": "sonnet-5",
        "premium": "opus-5-5",
        "frontier": "fable-5-1"
      },
      "effort": {
        "scout": "low",
        "worker": "low",
        "implementation_fast": "low"
      }
    },
    "openai": {
      "description": "OpenAI only. Luna cheap, gpt-6-sol mid and premium (premium at high effort), astra frontier. Codex first, Bedrock fallback.",
      "tiers": {
        "cheap": "gpt-6-luna",
        "mid": "gpt-6-sol",
        "premium": "gpt-6-sol",
        "frontier": "astra"
      },
      "effort": {
        "lead": "high",
        "architect": "high",
        "analysis_strong": "high",
        "security_review": "high"
      }
    },
    "oss": {
      "description": "HUMAIN-node open models: GLM 5.2 architecture/security/frontier, MiniMax M3 leadership and strong implementation, Qwen worker, Kimi review, HUMAIN M3 Research QA.",
      "tiers": {
        "cheap": "humain-node/qwen3.8-27b",
        "mid": "humain-node/minimax-m3",
        "premium": "humain-node/glm-5.2",
        "frontier": "humain-node/glm-5.2"
      },
      "capabilities": {
        "lead_small": "humain-node/minimax-m3",
        "lead": "humain-node/minimax-m3",
        "technical_review": "humain-node/kimi-k3",
        "qa_agent": "humain-node/humain-m3-research-preview"
      }
    }
  }
}
```

- [ ] **Step 4: Change `emptyProfilesFile` in `models.ts`**

```ts
export function emptyProfilesFile(): ProfilesFile {
	return { version: 1, active_profile: "premium", profiles: { premium: {} } };
}
```

In `index.ts` `loadProfiles()`, the legacy-adapter migration writes profile `"default"`; change it to write the shipped file instead when the legacy adapter exists and the profiles file does not:

```ts
			const shipped = join(SKILL_ROOT, "bridge", "orchestrator-profiles.json");
			const file = parseProfilesFile(JSON.parse(readFileSync(shipped, "utf-8"))).file;
			writeProfilesFile(file);
			notes.push(`installed ${shipped} → ${PROFILES_PATH}; legacy ${LEGACY_ADAPTER_PATH} is ignored (active profile "premium")`);
```

- [ ] **Step 5: Replace `FALLBACK_ADAPTER` in `index.ts`** (no haiku, includes lead sizes):

```ts
const FALLBACK_ADAPTER: Record<string, { model: string; effort?: string }> = {
	scout:                { model: "amazon-bedrock/global.openai.gpt-6-luna" },
	worker:               { model: "amazon-bedrock/global.openai.gpt-6-luna" },
	implementation_fast:  { model: "amazon-bedrock/global.openai.gpt-6-luna" },
	analysis_mid:         { model: "amazon-bedrock/global.anthropic.claude-sonnet-5" },
	technical_lead:       { model: "amazon-bedrock/global.anthropic.claude-sonnet-5" },
	lead_small:           { model: "amazon-bedrock/global.anthropic.claude-sonnet-5" },
	implementation_strong:{ model: "amazon-bedrock/global.anthropic.claude-sonnet-5" },
	technical_review:     { model: "amazon-bedrock/global.openai.gpt-6-sol" },
	integration_review:   { model: "amazon-bedrock/global.openai.gpt-6-sol" },
	migration_review:     { model: "amazon-bedrock/global.openai.gpt-6-sol" },
	performance_review:   { model: "amazon-bedrock/global.openai.gpt-6-sol" },
	api_contract_review:  { model: "amazon-bedrock/global.openai.gpt-6-sol" },
	qa_agent:             { model: "amazon-bedrock/global.anthropic.claude-sonnet-5" },
	lead:                 { model: "amazon-bedrock/global.anthropic.claude-opus-5-5" },
	architect:            { model: "amazon-bedrock/global.anthropic.claude-opus-5-5" },
	analysis_strong:      { model: "amazon-bedrock/global.anthropic.claude-opus-5-5" },
	security_review:      { model: "amazon-bedrock/global.anthropic.claude-opus-5-5" },
	lead_large:           { model: "amazon-bedrock/global.anthropic.claude-fable-5-1" },
};
```

Replace the doc comment above it with: "Last-resort bindings when neither a profile nor the dynamic resolver yields a model. Mirrors the `premium` profile; never haiku."

- [ ] **Step 6: Persona defaults.** In `bridge/agents/orch-scout.md`, `orch-worker.md`, `orch-implementation-fast.md` set `model: amazon-bedrock/global.openai.gpt-6-luna`; `orch-technical-review.md` → `amazon-bedrock/global.openai.gpt-6-sol`; `orch-architect.md`, `orch-security-review.md` → `amazon-bedrock/global.anthropic.claude-opus-5-5`. Verify:

```bash
rg -n "haiku" bridge/agents bridge/extensions/orchestrator/index.ts bridge/orchestrator-profiles.json orchestrator/method.json
```

Expected: no matches.

- [ ] **Step 7: install.sh installs profiles with backup.** After the agents copy block add:

```bash
PROFILES_SRC="$BRIDGE_DIR/orchestrator-profiles.json"
PROFILES_DST="$TARGET_DIR/orchestrator-profiles.json"
if [ -f "$PROFILES_DST" ] && ! cmp -s "$PROFILES_SRC" "$PROFILES_DST"; then
  cp "$PROFILES_DST" "$PROFILES_DST.bak-$(date -u +%Y%m%dT%H%M%SZ)"
fi
cp "$PROFILES_SRC" "$PROFILES_DST"
echo "installed orchestrator profiles -> $PROFILES_DST (active: premium)"
```

Test in a temp dir:

```bash
T=$(mktemp -d); echo '{"version":1,"active_profile":"default","profiles":{"default":{}}}' > "$T/orchestrator-profiles.json"
HUMAIN_TERMINAL_AGENT_DIR="$T" ./install.sh >/dev/null
ls "$T" | grep -c 'orchestrator-profiles.json.bak-'; grep -c '"active_profile": "premium"' "$T/orchestrator-profiles.json"
```

Expected: `1` and `1`.

- [ ] **Step 8: Run all tests**

Run: `bun test ./bridge && python3 -B -m pytest -p no:cacheprovider -q`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add bridge/orchestrator-profiles.json bridge/agents install.sh bridge/extensions/orchestrator/index.ts bridge/extensions/orchestrator/models.ts bridge/extensions/orchestrator/models.test.ts
git commit -m "feat(profiles): premium/anthropic/openai/oss profiles, premium default, no haiku"
```

### Task A3: Lead sizing module

**Files:**
- Create: `bridge/extensions/orchestrator/lead-sizing.ts`
- Test: `bridge/extensions/orchestrator/lead-sizing.test.ts`

**Interfaces:**
- Consumes: `METHOD`, `LeadSize` from `models.ts`.
- Produces:
  - `isLeadSize(s: string): s is LeadSize`
  - `sizeLead(input: { complexity: number; risk: string; override?: LeadSize; source: "triage" | "heuristic" | "flag" }): LeadSizeDecision`
  - `interface LeadSizeDecision { size: LeadSize; capability: string; bandSize: LeadSize; riskFloorSize: LeadSize; source: "triage" | "heuristic" | "flag" | "escalation" }`
  - `escalateLeadCapability(capability: string): string | null` — next size's capability; `null` at `lead_large` or for non-lead capabilities.
  - `isLeadCapability(capability: string): boolean`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { escalateLeadCapability, isLeadCapability, isLeadSize, sizeLead } from "./lead-sizing.ts";

describe("sizeLead", () => {
	const cases: Array<[number, string, string]> = [
		[1, "low", "small"], [3, "low", "small"], [4, "low", "standard"], [6, "low", "standard"],
		[7, "low", "large"], [10, "low", "large"], [2, "medium", "standard"], [2, "high", "large"],
		[2, "critical", "large"], [5, "high", "large"],
	];
	for (const [c, r, size] of cases) {
		test(`complexity ${c} risk ${r} -> ${size}`, () => expect(sizeLead({ complexity: c, risk: r, source: "triage" }).size).toBe(size));
	}
	test("maps size to capability", () => {
		expect(sizeLead({ complexity: 2, risk: "low", source: "triage" }).capability).toBe("lead_small");
		expect(sizeLead({ complexity: 5, risk: "low", source: "triage" }).capability).toBe("lead");
		expect(sizeLead({ complexity: 9, risk: "low", source: "triage" }).capability).toBe("lead_large");
	});
	test("out-of-range, NaN, unknown risk", () => {
		expect(sizeLead({ complexity: 99, risk: "low", source: "triage" }).size).toBe("large");
		expect(sizeLead({ complexity: -3, risk: "low", source: "triage" }).size).toBe("small");
		expect(sizeLead({ complexity: Number.NaN, risk: "low", source: "triage" }).size).toBe("standard");
		expect(sizeLead({ complexity: 2, risk: "weird", source: "triage" }).size).toBe("standard");
	});
	test("override wins over risk floor and is labelled flag", () => {
		const d = sizeLead({ complexity: 9, risk: "critical", override: "small", source: "flag" });
		expect(d.size).toBe("small");
		expect(d.source).toBe("flag");
		expect(d.bandSize).toBe("large");
		expect(d.riskFloorSize).toBe("large");
	});
});

describe("escalateLeadCapability", () => {
	test("walks up one size and stops at large", () => {
		expect(escalateLeadCapability("lead_small")).toBe("lead");
		expect(escalateLeadCapability("lead")).toBe("lead_large");
		expect(escalateLeadCapability("lead_large")).toBeNull();
		expect(escalateLeadCapability("technical_review")).toBeNull();
	});
	test("predicates", () => {
		expect(isLeadCapability("lead_small")).toBe(true);
		expect(isLeadCapability("architect")).toBe(false);
		expect(isLeadSize("standard")).toBe(true);
		expect(isLeadSize("huge")).toBe(false);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test ./bridge/extensions/orchestrator/lead-sizing.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `lead-sizing.ts`**

```ts
/**
 * Pure lead sizing (method.json rules.lead_sizing). Triage supplies complexity
 * and risk; this picks a lead size and the capability that size maps to. No
 * model names: profiles bind lead_small/lead/lead_large through tiers.
 */
import { METHOD, type LeadSize } from "./models.ts";

const ORDER: LeadSize[] = ["small", "standard", "large"];

export interface LeadSizeDecision {
	size: LeadSize;
	capability: string;
	bandSize: LeadSize;
	riskFloorSize: LeadSize;
	source: "triage" | "heuristic" | "flag" | "escalation";
}

export function isLeadSize(s: string): s is LeadSize {
	return (ORDER as string[]).includes(s);
}

export function isLeadCapability(capability: string): boolean {
	return Object.values(METHOD.rules.lead_sizing.sizes).includes(capability);
}

export function sizeLead(input: {
	complexity: number;
	risk: string;
	override?: LeadSize;
	source: "triage" | "heuristic" | "flag";
}): LeadSizeDecision {
	const rule = METHOD.rules.lead_sizing;
	const raw = Number.isFinite(input.complexity) ? Math.round(input.complexity) : 5;
	const c = Math.max(1, Math.min(10, raw));
	const bandSize = rule.by_complexity.find((b) => c >= b.min && c <= b.max)?.size ?? rule.by_complexity[rule.by_complexity.length - 1].size;
	const riskFloorSize = rule.risk_floor[input.risk] ?? rule.risk_floor.medium;
	const size = input.override ?? (ORDER.indexOf(bandSize) >= ORDER.indexOf(riskFloorSize) ? bandSize : riskFloorSize);
	return { size, capability: rule.sizes[size], bandSize, riskFloorSize, source: input.source };
}

export function escalateLeadCapability(capability: string): string | null {
	const rule = METHOD.rules.lead_sizing;
	const current = ORDER.find((s) => rule.sizes[s] === capability);
	if (!current) return null;
	const next = ORDER[ORDER.indexOf(current) + 1];
	return next ? rule.sizes[next] : null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test ./bridge/extensions/orchestrator/lead-sizing.test.ts`
Expected: PASS.

- [ ] **Step 5: Parity test with Python** — add to `tests/test_method.py`:

```python
    def test_lead_size_parity_with_bridge_cases(self):
        cases = [(1,"low","small"),(3,"low","small"),(4,"low","standard"),(6,"low","standard"),
                 (7,"low","large"),(10,"low","large"),(2,"medium","standard"),(2,"high","large"),
                 (2,"critical","large"),(5,"high","large"),(2,"weird","standard")]
        for c, r, size in cases:
            self.assertEqual(method.lead_size(c, r), size, (c, r))
```

Run: `python3 -B -m pytest -p no:cacheprovider -q tests/test_method.py` → PASS.

- [ ] **Step 6: Commit**

```bash
git add bridge/extensions/orchestrator/lead-sizing.ts bridge/extensions/orchestrator/lead-sizing.test.ts tests/test_method.py
git commit -m "feat(bridge): pure lead sizing from triage complexity and risk"
```

### Task A4: Wire lead sizing, `--lead-size`, tier lookup, escalation, delegation, tagging into the bridge

**Files:**
- Modify: `bridge/extensions/orchestrator/models.ts` (add `tierOfModel`, `classifyModelName`)
- Modify: `bridge/extensions/orchestrator/index.ts` (`OrchestrateArgs`, `parseArgs`, triage handler, `dispatchHierarchical`, `dispatchReconAndLeads`, `planEscalation`, `pickModel`, `cheapestAtTier`, `captureDispatchCost`, usage text)
- Modify: `bridge/agents/orchestrator-lead.md`
- Test: `bridge/extensions/orchestrator/models.test.ts`, `bridge/extensions/orchestrator/index.test.ts`

**Interfaces:**
- Consumes: `sizeLead`, `escalateLeadCapability`, `isLeadCapability`, `isLeadSize` (Task A3).
- Produces:
  - `models.ts`: `classifyModelName(model: string): Tier | "unknown"`; `tierOfModel(model: string, adapter: Record<string, Binding>): Tier | "unknown"`.
  - `OrchestrateArgs.leadSize?: LeadSize`.
  - `dispatchReconAndLeads` input gains `leadCapability: string` (default `"lead"`).
  - `planEscalation(...)` returns lead retries on `escalateLeadCapability(cap) ?? cap`.
  - Events: `lead_sized` with fields `run_id, complexity, risk, band_size, risk_floor_size, size, capability, model, source`.
  - Every `captureDispatchCost` metric carries `profile`, `policy_id`, `lead_size`.

- [ ] **Step 1: Failing tests for tier lookup** (append to `models.test.ts`):

```ts
import { classifyModelName, tierOfModel } from "./models.ts";

describe("tierOfModel", () => {
	const adapter = {
		scout: { model: "amazon-bedrock/global.openai.gpt-6-luna" },
		lead_small: { model: "amazon-bedrock/global.openai.gpt-6-sol" },
		lead: { model: "amazon-bedrock/global.openai.gpt-6-sol" },
		lead_large: { model: "openai-codex/gpt-6-astra" },
	};
	test("highest tier of any capability bound to the model", () => {
		expect(tierOfModel("amazon-bedrock/global.openai.gpt-6-sol", adapter)).toBe("premium");
		expect(tierOfModel("openai-codex/gpt-6-astra", adapter)).toBe("frontier");
		expect(tierOfModel("amazon-bedrock/global.openai.gpt-6-luna", adapter)).toBe("cheap");
	});
	test("falls back to name classification", () => {
		expect(tierOfModel("amazon-bedrock/global.anthropic.claude-fable-5-1", {})).toBe("frontier");
		expect(classifyModelName("global.anthropic.claude-opus-5-5")).toBe("premium");
		expect(classifyModelName("global.anthropic.claude-sonnet-5")).toBe("mid");
		expect(classifyModelName("gpt-6-sol")).toBe("mid");
		expect(classifyModelName("gpt-6-luna")).toBe("cheap");
		expect(classifyModelName("mystery-9")).toBe("unknown");
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test ./bridge/extensions/orchestrator/models.test.ts` → FAIL (exports missing).

- [ ] **Step 3: Implement in `models.ts`**

```ts
/** Name-based tier guess, used only when the adapter does not bind the model. */
export function classifyModelName(model: string): Tier | "unknown" {
	const n = (model.includes("/") ? model.slice(model.indexOf("/") + 1) : model).toLowerCase();
	if (/\bfable\b|\bastra\b/.test(n)) return "frontier";
	if (/\bopus\b|\bkimi-k3\b|\bultra\b/.test(n)) return "premium";
	if (/\bsonnet\b|\bsol\b|\bterra\b|\bglm\b|\bminimax\b|\bmistral\b/.test(n)) return "mid";
	if (/\bluna\b|\bmini\b|\bnano\b|\blite\b|\bqwen3\.8\b/.test(n)) return "cheap";
	return "unknown";
}

/** A model's tier = the highest tier of any capability the resolved adapter binds it to. */
export function tierOfModel(model: string, adapter: Record<string, Binding>): Tier | "unknown" {
	let best = -1;
	for (const [cap, b] of Object.entries(adapter)) {
		if (b?.model !== model) continue;
		const t = tierOf(cap);
		if (t && tierIndex(t) > best) best = tierIndex(t);
	}
	return best >= 0 ? METHOD.tiers[best] : classifyModelName(model);
}
```

Run: `bun test ./bridge/extensions/orchestrator/models.test.ts` → PASS.

- [ ] **Step 4: Failing bridge tests** (append to `index.test.ts`; `parseArgs`, `dispatchReconAndLeads`, `leadPrompt` are already exported):

```ts
import { parseArgs, dispatchReconAndLeads, planEscalationForTest } from "./index.ts";

describe("lead sizing wiring", () => {
	test("--lead-size parses and rejects junk", () => {
		expect(parseArgs("do x --lead-size small").leadSize).toBe("small");
		const bad = parseArgs("do x --lead-size huge");
		expect(bad.leadSize).toBeUndefined();
		expect(bad.unknownFlags).toContain("--lead-size huge");
	});
	test("dispatchReconAndLeads dispatches the sized lead capability", async () => {
		const dispatched: string[] = [];
		const plan = { complexity: 2, task_class: "implementation", risk: "low", topology: { leads: 1, depth: 2, shape: "single", workers: 0 }, route: { recommended: { capability: "implementation_strong", effort: "standard" }, mode: "recommend" }, effective_quality_floor: 0.95 } as any;
		await dispatchReconAndLeads(
			{ runId: "r1", goal: "g", plan, adapter: { lead_small: { model: "m/sonnet-5" } } as any, leadCapability: "lead_small" },
			{
				dispatch: async (tasks) => { dispatched.push(...tasks.map((t) => t.capability)); return tasks.map((t) => ({ taskId: t.taskId, capability: t.capability, exitCode: 0, stdout: "", stderr: "", costUsd: 0, durationMs: 0 } as any)); },
				capture: async () => {}, setPhase: () => {}, throwIfCancelled: () => {},
			},
		);
		expect(dispatched).toEqual(["lead_small"]);
	});
	test("failed verification escalates the lead one size", () => {
		const tasks = planEscalationForTest(["tests failed"], [{ capability: "lead_small", task: "t", taskId: "r-lead-0" }], 2, "low", 0);
		expect(tasks[0].capability).toBe("lead");
		const top = planEscalationForTest(["tests failed"], [{ capability: "lead_large", task: "t", taskId: "r-lead-0" }], 9, "low", 0);
		expect(top[0].capability).toBe("lead_large");
	});
});
```

- [ ] **Step 5: Run to verify failure**

Run: `bun test ./bridge/extensions/orchestrator/index.test.ts` → FAIL.

- [ ] **Step 6: Implement in `index.ts`**

1. `OrchestrateArgs` gains `/** --lead-size small|standard|large; overrides triage and the risk floor. */ leadSize?: LeadSize;`. In `parseArgs` add:

```ts
			case "--lead-size": {
				if (next && isLeadSize(next)) { out.leadSize = next; i++; }
				else { out.unknownFlags.push(`--lead-size ${next ?? ""}`.trim()); if (next) i++; }
				break;
			}
```

Add `[--lead-size small|standard|large]` to the usage string next to `--profile`.

2. After the triage block (where `effectiveComplexity`/`effectiveRisk` are final), size the lead and record it:

```ts
				const leadDecision = sizeLead({
					complexity: effectiveComplexity,
					risk: effectiveRisk,
					override: parsed.leadSize,
					source: parsed.leadSize ? "flag" : triageResult ? "triage" : "heuristic",
				});
				const leadModel = adapter[leadDecision.capability]?.model ?? adapter.lead?.model ?? "unknown";
				await recordEvent("lead_sized", {
					run_id: runId, complexity: effectiveComplexity, risk: effectiveRisk,
					band_size: leadDecision.bandSize, risk_floor_size: leadDecision.riskFloorSize,
					size: leadDecision.size, capability: leadDecision.capability, model: leadModel, source: leadDecision.source,
				});
				session.log(`lead size: ${leadDecision.size} (${leadDecision.capability} → ${shortName(leadModel)}; source ${leadDecision.source})`);
```

Include the line `lead:     ${leadDecision.size} → ${shortName(leadModel)}` in the pre-dispatch summary shown next to the existing `triage:` line.

3. Pass `leadDecision.capability` through `dispatchHierarchical(...)` (new trailing parameter `leadCapability: string`) into `dispatchReconAndLeads` input as `leadCapability`. In `dispatchReconAndLeads` default it (`const leadCapability = input.leadCapability ?? "lead";`), use it for `capability` in `leadTasks`, and in the phase text `shortName(adapter[leadCapability]?.model ?? "?")`.

4. `planEscalation`: compute the retry capability and export a test alias:

```ts
	const lead = METHOD.rules.lead_sizing.escalate_on_verification_failure && isLeadCapability(target.capability);
	const capability = lead ? escalateLeadCapability(target.capability) ?? target.capability : target.capability;
	return [
		{
			...target,
			capability,
			taskId: `${target.taskId}-retry-${retryCount + 1}`,
			retryOf: target.taskId,
			retryCount: retryCount + 1,
			task: [ /* existing lines unchanged */ ].join("\n"),
		},
	];
}
export const planEscalationForTest = planEscalation;
```

Replace the two hard-coded strings in that task text with tier-neutral wording: `"Risk is high/critical: re-review MUST use at least the premium tier."` / `"Re-review must use at least the mid tier."`. In the escalation dispatch loop, when `lead` escalated, record `lead_sized` with `source: "escalation"`.

5. Delete `classifyTier`; in `pickModel` and `cheapestAtTier` use `tierOfModel(model, adapter)` (full `provider/id`, not the split name). Delete `RULE_REVIEW_AFTER_FIX_MIN_TIER` if unused.

6. `captureDispatchCost`: add to the emitted metric and `route_executed` rows `profile: RESOLVED_PROFILE_NAME`, `policy_id: RESOLVED_POLICY_ID`, `lead_size: CURRENT_LEAD_SIZE`, where these module-level values are set once per run after `resolveAdapter`:

```ts
function policyIdFor(profileName: string, adapter: Adapter): string {
	const canon = Object.keys(adapter).sort().map((c) => `${c}=${adapter[c].model}@${adapter[c].effort ?? ""}`).join(";");
	return `${profileName}-${createHash("sha256").update(canon).digest("hex").slice(0, 8)}`;
}
```

(`createHash` from `node:crypto`.)

7. `bridge/agents/orchestrator-lead.md`: set `tools: read, bash, grep, find, ls, subagent` and `model: amazon-bedrock/global.anthropic.claude-opus-5-5`. In its Workflow add as step 0: "You do not have write or edit tools. All source changes go to `orch-implementation-strong` or `orch-implementation-fast` through `subagent`. Do not modify files through bash redirection or scripts." Add the same sentence to `leadPrompt` just before the model table.

8. In `captureDispatchCost`, for lead capabilities set `lead_self_implemented: true` when `filesChanged.length > 0` and the lead's stdout contains no `orch-implementation-` mention.

- [ ] **Step 7: Run all tests**

Run: `bun test ./bridge && python3 -B -m pytest -p no:cacheprovider -q`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add bridge/ && git commit -m "feat(bridge): triage-sized lead, --lead-size, lead escalation, tier lookup from adapter, delegation-only lead, policy tagging"
```

### Task A5: Per-dispatch spend cap

**Files:**
- Create: `bridge/extensions/orchestrator/spend-cap.ts`
- Test: `bridge/extensions/orchestrator/spend-cap.test.ts`
- Modify: `bridge/extensions/orchestrator/index.ts` (`RunSession` `message_end` handler; `runSubagentProcess` kill path)

**Interfaces:**
- Produces: `capFor(capability: string, policy?: SpendCapPolicy): number`; `class SpendCapTracker { constructor(policy?: SpendCapPolicy); observe(taskId: string, capability: string, costUsd: number): "ok" | "warn" | "stop" }` — returns non-`ok` exactly once per `taskId`; `"stop"` only in `enforce`.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, test } from "bun:test";
import { SpendCapTracker, capFor } from "./spend-cap.ts";

const policy = { mode: "warn" as const, usd_by_capability: { lead: 4, lead_large: 10 }, default_usd: 1 };

describe("spend cap", () => {
	test("capFor uses capability then default", () => {
		expect(capFor("lead", policy)).toBe(4);
		expect(capFor("scout", policy)).toBe(1);
	});
	test("warn fires once when crossed, including a single big jump", () => {
		const t = new SpendCapTracker(policy);
		expect(t.observe("a", "lead", 3.9)).toBe("ok");
		expect(t.observe("a", "lead", 12)).toBe("warn");
		expect(t.observe("a", "lead", 20)).toBe("ok");
		expect(t.observe("b", "lead", 0)).toBe("ok");
	});
	test("enforce returns stop once", () => {
		const t = new SpendCapTracker({ ...policy, mode: "enforce" });
		expect(t.observe("a", "lead_large", 10.01)).toBe("stop");
		expect(t.observe("a", "lead_large", 11)).toBe("ok");
	});
	test("off never fires", () => {
		const t = new SpendCapTracker({ ...policy, mode: "off" });
		expect(t.observe("a", "lead", 1000)).toBe("ok");
	});
});
```

- [ ] **Step 2: Run → FAIL** (`bun test ./bridge/extensions/orchestrator/spend-cap.test.ts`).

- [ ] **Step 3: Implement**

```ts
/** Pure per-dispatch spend cap (method.json rules.dispatch_spend_cap). */
import { METHOD } from "./models.ts";

export type SpendCapPolicy = typeof METHOD.rules.dispatch_spend_cap;

export function capFor(capability: string, policy: SpendCapPolicy = METHOD.rules.dispatch_spend_cap): number {
	return policy.usd_by_capability[capability] ?? policy.default_usd;
}

export class SpendCapTracker {
	private readonly fired = new Set<string>();
	constructor(private readonly policy: SpendCapPolicy = METHOD.rules.dispatch_spend_cap) {}
	observe(taskId: string, capability: string, costUsd: number): "ok" | "warn" | "stop" {
		if (this.policy.mode === "off" || this.fired.has(taskId)) return "ok";
		if (!(costUsd > capFor(capability, this.policy))) return "ok";
		this.fired.add(taskId);
		return this.policy.mode === "enforce" ? "stop" : "warn";
	}
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Wire into `index.ts`.** `RunSession` owns `readonly spendCaps = new SpendCapTracker();` and a per-dispatch `capability` stored on `DispatchProgress` (set in `startDispatch`). In the `message_end` branch after `d.costUsd += ...`:

```ts
					const verdict = this.spendCaps.observe(taskId, d.capability ?? "unknown", d.costUsd);
					if (verdict !== "ok") {
						const cap = capFor(d.capability ?? "unknown");
						this.log(`  ${taskId} spend cap $${cap.toFixed(2)} exceeded at $${d.costUsd.toFixed(4)} (${verdict})`);
						void recordEvent("spend_cap_exceeded", { run_id: this.runId, task_id: taskId, capability: d.capability, cap_usd: cap, cost_usd: d.costUsd, action: verdict });
						this.notify?.(`Spend cap $${cap.toFixed(2)} exceeded by ${taskId} ($${d.costUsd.toFixed(2)})${verdict === "stop" ? " — stopping it" : ""}`, "warning");
						if (verdict === "stop") this.stopDispatch(taskId, "spend_cap");
					}
```

`stopDispatch(taskId, reason)` looks up the child registered by `runSubagentProcess` (add `session.registerChild(taskId, proc)` right after spawn and `unregisterChild` on close) and calls the existing `killProcessTree(proc)`; `runSubagentProcess` reports `outcome: "failed"`, `stopReason: "spend_cap"` when the session marked the task stopped.

Add an `index.test.ts` case using the existing `spawnChild` seam: a fixture child that emits two `message_end` events with `usage.cost.total` 3 and 5 under capability `lead` with an enforce-mode tracker injected via the session → result `stopReason === "spend_cap"` and exactly one `spend_cap_exceeded` recorded.

- [ ] **Step 6: Run all tests → PASS. Commit**

```bash
git add bridge/extensions/orchestrator/spend-cap.ts bridge/extensions/orchestrator/spend-cap.test.ts bridge/extensions/orchestrator/index.ts bridge/extensions/orchestrator/index.test.ts
git commit -m "feat(bridge): per-dispatch spend cap (warn, enforce, off)"
```

### Task A6: Codex → Bedrock quota fallback

**Files:**
- Create: `bridge/extensions/orchestrator/provider-fallback.ts`
- Test: `bridge/extensions/orchestrator/provider-fallback.test.ts`
- Modify: `bridge/extensions/orchestrator/index.ts` (`dispatchParallel` per-task completion)

**Interfaces:**
- Consumes: `AliasTable`, `resolveAlias` from `models.ts`.
- Produces: `isQuotaError(text: string): boolean`; `bedrockFallbackFor(model: string, table: AliasTable): string | null`.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, test } from "bun:test";
import { buildAliasTable } from "./models.ts";
import { bedrockFallbackFor, isQuotaError } from "./provider-fallback.ts";

const table = buildAliasTable([
	{ provider: "openai-codex", id: "gpt-6-astra" },
	{ provider: "amazon-bedrock", id: "global.openai.gpt-6-astra" },
	{ provider: "amazon-bedrock", id: "us.openai.gpt-6-astra" },
	{ provider: "openai-codex", id: "gpt-5.3-codex-spark" },
]);

describe("provider fallback", () => {
	test("detects quota errors", () => {
		for (const s of ["usage limit reached", "429 Too Many Requests", "rate_limit_error", "Weekly credit cap reached", "quota exceeded"]) {
			expect(isQuotaError(s)).toBe(true);
		}
		expect(isQuotaError("TypeError: x is undefined")).toBe(false);
	});
	test("maps codex model to global bedrock twin", () => {
		expect(bedrockFallbackFor("openai-codex/gpt-6-astra", table)).toBe("amazon-bedrock/global.openai.gpt-6-astra");
	});
	test("no twin or non-codex -> null", () => {
		expect(bedrockFallbackFor("openai-codex/gpt-5.3-codex-spark", table)).toBeNull();
		expect(bedrockFallbackFor("amazon-bedrock/global.openai.gpt-6-astra", table)).toBeNull();
	});
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

```ts
/** Pure codex-first / Bedrock-fallback helpers. */
import { resolveAlias, type AliasTable } from "./models.ts";

export const QUOTA_ERROR_RE = /usage limit|quota|rate.?limit|credit cap|\b429\b/i;

export function isQuotaError(text: string): boolean {
	return QUOTA_ERROR_RE.test(text);
}

export function bedrockFallbackFor(model: string, table: AliasTable): string | null {
	if (!model.startsWith("openai-codex/")) return null;
	const id = model.slice("openai-codex/".length);
	const twin = (table.byAlias.get(id.toLowerCase()) ?? []).filter((c) => c.startsWith("amazon-bedrock/"));
	if (twin.length === 0) return null;
	return resolveAlias(`amazon-bedrock/${id}`, table, ["amazon-bedrock"]).model ?? null;
}
```

Note: `deriveAliases("global.openai.gpt-6-astra")` includes `gpt-6-astra`, so the alias lookup finds the twin; `chooseCandidate` prefers `global.`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Wire into `dispatchParallel`.** After a task's `runSubagentProcess` returns with `exitCode !== 0` and `isQuotaError(result.stderr + "\n" + result.finalText)`, compute `const twin = bedrockFallbackFor(model, ALIAS_TABLE)`; if `twin`, `await recordEvent("route_degraded", { run_id: runId, task_id: t.taskId, capability: t.capability, from_model: model, to_model: twin, reason: "provider_quota" })`, then rerun the same task once with `model: twin` and return that result (billing both attempts through the existing capture path). `ALIAS_TABLE` is the table built in `resolveAdapter`; store it on the run. Add an `index.test.ts` case using the `spawnChild` seam: first child exits 1 with stderr `usage limit reached`, second exits 0 → one `route_degraded` event and the final result's `model` is the Bedrock twin; a second case with no twin → no redispatch, original failure returned.

- [ ] **Step 6: Run all tests → PASS. Commit**

```bash
git add bridge/extensions/orchestrator/provider-fallback.ts bridge/extensions/orchestrator/provider-fallback.test.ts bridge/extensions/orchestrator/index.ts bridge/extensions/orchestrator/index.test.ts
git commit -m "feat(bridge): codex-first with one-shot Bedrock fallback on quota errors"
```

### Task A7: Docs, dashboard columns, install, and phase acceptance

**Files:**
- Modify: `SKILL.md` (routing tables, rule 1 wording, new "Lead sizing", "Spend cap", "Provider fallback" sections, safe defaults)
- Modify: `bridge/README.md`, `README.md` (profiles, `--lead-size`)
- Modify: `orchestrator/dashboard.py` (group lead cost and verified pass by `lead_size` and `profile`)
- Test: `tests/test_dashboard_metrics.py`

- [ ] **Step 1: Failing dashboard test** — add to `tests/test_dashboard_metrics.py` a synthetic history with two `model_call` rows `{role: "lead_small", lead_size: "small", profile: "premium", cost_usd: 0.05, run_id: "r1"}` and `{role: "lead_large", lead_size: "large", profile: "premium", cost_usd: 6.0, run_id: "r2"}` plus `run_completed` verification passed for r1 and failed for r2, then assert:

```python
        data = dashboard.build_data(root)
        by = {row["lead_size"]: row for row in data["lead_sizes"]}
        self.assertAlmostEqual(by["small"]["cost"], 0.05)
        self.assertEqual(by["small"]["verified_pass"], 1)
        self.assertEqual(by["large"]["verified_fail"], 1)
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement** `lead_sizes` in `dashboard.build_data` (group orchestrated `model_call` rows with a `lead_size` by size; join run verification by `run_id`; fields `lead_size, runs, cost, verified_pass, verified_fail`) and render a "Lead sizing" table. **Step 4: Run → PASS.**

- [ ] **Step 5: SKILL.md.** Replace haiku mentions in routing text with "cheap tier"; update the Rule 1 table's `Model tier min` column to tiers (`mid`, `mid`, `premium`, `frontier`); add:

```markdown
### Rule 4: Lead sizing

Triage classifies complexity and risk; `method.json` `rules.lead_sizing` turns them into a lead size:
`small` (complexity 1–3) → `lead_small` (mid tier), `standard` (4–6) → `lead` (premium),
`large` (7–10) → `lead_large` (frontier). Risk floors: medium ≥ standard, high/critical = large.
`--lead-size` overrides. A lead that fails verification is retried one size up. The lead never
edits files; it delegates to implementers.
```

Add short sections for the spend cap (`warn` today) and codex-first/Bedrock fallback. Update Safe defaults: `re-review minimum tier: mid`, `lead sizing: on`, `spend cap: warn`.

- [ ] **Step 6: Full verification and install into a temp agent dir**

```bash
bun test ./bridge && python3 -B -m pytest -p no:cacheprovider -q
T=$(mktemp -d); HUMAIN_TERMINAL_AGENT_DIR="$T" ./install.sh && ls "$T" "$T/agents"
rg -n "haiku" SKILL.md bridge/agents bridge/orchestrator-profiles.json orchestrator/method.json bridge/extensions/orchestrator/index.ts
```

Expected: tests pass; profiles and agents installed; the `rg` finds nothing.

- [ ] **Step 7: Commit, merge, clean up the phase worktree**

```bash
git add -A && git commit -m "docs+dashboard: lead sizing, profiles, spend cap, provider fallback"
cd ../.. && git merge --no-ff feat/economics-phase-a -m "merge: economics phase A"
bun test ./bridge && python3 -B -m pytest -p no:cacheprovider -q
git worktree remove .worktrees/economics-a && git branch -d feat/economics-phase-a
./install.sh
```

- [ ] **Step 8: Live acceptance (with the user).** Reload HT. Run three real tasks of different sizes, e.g. `/orchestrate "fix typo in README" `, a complexity ~5 task, and a complexity ~8 task. For each confirm from `events.jsonl` a `lead_sized` event with the expected size and model, no `edit`/`write` tool calls by the lead in its `*.events.jsonl`, and `policy_id`/`profile`/`lead_size` on its `model_call` rows. Regenerate the dashboard and record the "Lead sizing" table in the PR description. Phase A exits when ≥ 10 new runs show verified-pass ≥ 11/17-equivalent (65%) and lower average lead cost per run than $5.34.

### Task A8: Orchestrator fixes from run `ht-orch-1790237987755-lyjkn8` (added 2026-09-24)

That run (goal: Phase 0 + A) reported `verification: PASS` and `files: 3 changed`, although every lead stopped at the Task 0.1 preflight and changed nothing. QA verified files a concurrent session was editing, and three parallel leads cloned the same goal and repeated the same preflight.

**Files:** create `bridge/extensions/orchestrator/run-outcome.ts` + test and `bridge/extensions/orchestrator/lead-plan.ts` + test; modify `index.ts` (`architectPrompt`, `leadPrompt`, `dispatchReconAndLeads`, finalize block, `runVerification`, `runCompletionOutcomeFor`) and `bridge/agents/orchestrator-lead.md`.

**Interfaces:**
- `parseLeadStatus(report): "completed" | "partial" | "blocked" | "unknown"` — last `STATUS:` line.
- `parseLeadFilesChanged(report): { kind: "none" } | { kind: "list"; files } | { kind: "unknown" }`.
- `classifyRunOutcome({ leadStatuses, succeededLeads, leads }): "blocked" | "dispatched" | "failed"`.
- `externalChangeFiles(gitChanged, leadReports): string[]` — all git-changed files, only when every lead says `Files Changed: None`.
- `parseLeadAssignments(architectText, leadCount): LeadAssignment[] | null`; `planLeadWaves(assignments): number[][]`.
- Events: `run_blocked`, `external_changes_detected`; run outcome `blocked`.

Behaviour:
1. **BLOCKED outcome.** Leads end with `STATUS: completed|partial|blocked` (`LEAD_STATUS_CONTRACT`). All blocked ⇒ summary `Orchestration BLOCKED`, verification `NOT RUN (blocked…)`, QA skipped, outcome `blocked` (never `verified` or `fail`).
2. **Dependent leads.** With `leads > 1` the architect must emit `## Lead assignments` (`Lead N: <scope> (depends on: none|i,j)`, backward dependencies only). Leads run in dependency waves; a lead whose dependency failed or was blocked is not started. Missing or invalid assignments ⇒ one lead with the whole goal.
3. **QA scope.** Files changed during the run while every lead reports `Files Changed: None` are excluded from QA and logged as `external_changes_detected`. The QA prompt (`QA_SCOPE_RULES`) restricts QA to the listed files and stops after 2 failed environment attempts with check `environment`.

Tests: `run-outcome.test.ts`, `lead-plan.test.ts`, and the `index.test.ts` block "orchestrator fixes from run ht-orch-1790237987755-lyjkn8 (A8)" (sequential waves, blocked dependency stops later waves, collapse to one lead, architect prompt section, lead scope in prompt, blocked outcome, QA scope rules).

---

## Phase B — Scouts first

Worktree: `.worktrees/economics-b` on `feat/economics-phase-b`, removed after merge.

### Task B1: Recon uses `scout` and starts at complexity 3

**Files:** `orchestrator/method.json`, `tests/test_method.py`, `bridge/extensions/orchestrator/recon.test.ts`

- [ ] **Step 1: Failing tests**

```python
    def test_recon_scout_threshold(self):
        r = method.rule("pre_implementation_recon")
        self.assertEqual(r["worker_capability"], "scout")
        self.assertEqual(method.recon_workers(3), 2)
        self.assertEqual(method.recon_workers(4), 2)
        self.assertEqual(method.recon_workers(5), 3)
        self.assertEqual(method.recon_workers(2), 0)
        self.assertEqual(method.recon_workers(6, "qa_verification"), 0)
```

```ts
test("complexity 3 plans two scout tasks", () => {
	const plans = planReconTasks({ method: METHOD.rules.pre_implementation_recon, complexity: 3, taskClass: "implementation", goal: "g", runId: "r" });
	expect(plans.length).toBe(2);
	expect(plans.every((p) => p.capability === "scout")).toBe(true);
});
```

- [ ] **Step 2: Run → FAIL. Step 3:** in `method.json` set `min_complexity: 3`, prepend `{ "min": 3, "max": 4, "workers": 2 }` to `workers_by_complexity`, `worker_capability: "scout"`, `worker_effort: "low"`; update `rationale` with the 3% compliance figure. In `rules.exploration_topology` set `recon_capability: "scout"`, `recon_effort: "low"`, and `worker: "scout"` for `issue_triage`, `plan_audit`, `codebase_recon` (investigation stays exempt from Rule 2 but is scout-first through this topology); add `self.assertEqual(method.rule("exploration_topology")["recon_capability"], "scout")` to the test. Update SKILL.md Rule 2 table. **Step 4: Run all tests → PASS. Step 5: Commit** `feat(method): scout recon from complexity 3`.

### Task B2: Plan-review gate before leads

**Files:** Create `bridge/extensions/orchestrator/plan-review.ts` + `plan-review.test.ts`; modify `index.ts` (`dispatchHierarchical` between architect and `dispatchReconAndLeads`).

**Interfaces:** `planReviewPrompt(goal: string, architectPlan: string, reconEvidence: string): string`; `parsePlanReviewVerdict(text: string): { verdict: "approve" | "revise"; findings: string[] }` — last line `VERDICT: APPROVE|REVISE`; anything unparseable is `approve` with finding `"unparsed plan review"` (fail-open, logged).

- [ ] **Step 1: Failing tests**

```ts
test("parses approve and revise", () => {
	expect(parsePlanReviewVerdict("ok\nVERDICT: APPROVE").verdict).toBe("approve");
	const r = parsePlanReviewVerdict("- missing migration\n- no tests for X\nVERDICT: REVISE");
	expect(r.verdict).toBe("revise");
	expect(r.findings).toEqual(["missing migration", "no tests for X"]);
});
test("unparseable is approve with a finding", () => {
	expect(parsePlanReviewVerdict("garbage")).toEqual({ verdict: "approve", findings: ["unparsed plan review"] });
});
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement**; in `dispatchHierarchical`, when `architectResult?.exitCode === 0`, dispatch one `technical_review` task (tools `read, grep, find, ls`) with `planReviewPrompt`; on `revise`, re-dispatch the architect once with the findings appended and use the revised plan; emit `plan_review` event `{verdict, findings_count, revised}`; bill both through `captureDispatchCost`. Add an `index.test.ts` case using fake `dispatch` effects that asserts a revise verdict causes exactly one architect re-dispatch. **Step 4: Run → PASS. Step 5: Commit** `feat(bridge): plan-review gate before leads`.

### Task B3: `/scout` for interactive sessions

**Files:** `index.ts` (register command), `bridge/README.md`, `SKILL.md`, `index.test.ts`.

**Interfaces:** `/scout [--n 1-5] <question>` → dispatches `n` (default 3) `scout` tasks through `planReconTasks` with `complexity` chosen so the band yields `n` (or passes explicit questions), returns `formatReconEvidence(results, RECON_EVIDENCE_MAX_CHARS)` into the chat, and records model_call metrics with `task_class: "interactive_scout"`.

- [ ] **Step 1: Failing test** — `parseScoutArgs("--n 2 where is auth handled?")` returns `{ n: 2, question: "where is auth handled?" }`; `--n 9` clamps to 5; empty question → error string.
- [ ] **Step 2: Run → FAIL. Step 3: Implement** `parseScoutArgs` (exported) and the command; SKILL.md gains: "In interactive sessions, send discovery questions (where is X, what calls Y, what tests cover Z) to `/scout` instead of reading the repository with the session model." **Step 4: Run → PASS. Step 5: Commit** `feat(bridge): /scout command for interactive discovery`.

### Task B4: Recon compliance on the dashboard

- [ ] Add `recon_coverage` to `dashboard.build_data`: eligible runs (complexity ≥ `min_complexity`, not skipped class) with ≥ required `scout` model_calls ÷ eligible runs; test with a synthetic history of 2 eligible runs, 1 compliant → `0.5`. Commit `feat(dashboard): recon coverage`. Merge phase B, remove the worktree, `./install.sh`.

---

## Phase C — Context, cache, and time

Worktree: `.worktrees/economics-c` on `feat/economics-phase-c`, removed after merge.

### Task C1: Cache-churn signal

**Files:** Create `bridge/extensions/orchestrator/cache-churn.ts` + test; modify `captureDispatchCost`; `orchestrator/dashboard.py` + `tests/test_dashboard_metrics.py`.

**Interfaces:** `isCacheChurn(u: { cacheWrite: number; output: number }): boolean` → `u.cacheWrite > 500_000 && u.cacheWrite > 3 * u.output`.

- [ ] **Step 1: Failing test**

```ts
expect(isCacheChurn({ cacheWrite: 466_462, output: 55_941 })).toBe(false); // below absolute floor
expect(isCacheChurn({ cacheWrite: 900_000, output: 50_000 })).toBe(true);
expect(isCacheChurn({ cacheWrite: 900_000, output: 400_000 })).toBe(false);
```

- [ ] **Steps 2–5:** implement; emit `cache_churn` event and `cache_churn: true` on the metric; dashboard "Cache churn" card = sum of cache-write cost on churn calls (cache-write tokens × `cache_write_per_mtok` from `config.json`); test with a synthetic row; commit `feat: cache churn detection`.

### Task C2: Fresh implementer per task with a bounded context packet

**Files:** `bridge/extensions/orchestrator/lead-prompt` section of `index.ts`, `bridge/agents/orch-implementation-strong.md`, `orch-implementation-fast.md`, `index.test.ts`.

- [ ] **Step 1: Failing test** — `leadPrompt(...)` output contains the exact block:

```
Implementer context packet (REQUIRED for every implementation subagent call):
- goal and acceptance criteria for this task only
- owned paths (files the implementer may change)
- the relevant recon evidence excerpt (≤ 2,000 tokens)
- the exact verification command
Start a new subagent per task; do not reuse one implementer for unrelated tasks.
Do not wait inside your own turn for more than 5 minutes on a single command; run long checks in a subagent.
```

- [ ] **Steps 2–5:** add the block to `leadPrompt`; add "You receive a context packet; do not explore beyond owned paths unless a test fails there" to both implementer personas; run tests; commit `feat: bounded context packets and short lead turns`.

### Task C3: Call-length target and review/QA scope

- [ ] Add `rules.call_length` to `method.json`: `{ "target_minutes": 20 }`; `captureDispatchCost` sets `over_target: true` when `durationMs > target`; dashboard shows p50/p90 duration by capability and count over target (test with synthetic durations 5, 25, 95 min → p90 index and `over_target_count == 2`).
- [ ] `orch-qa-agent.md` and `orch-technical-review.md`: "Review only the files listed in the task and their direct tests; do not read unrelated packages. Run deterministic checks (tests, lint, typecheck) before semantic review." `method.json` `rules.review_after_fix` unchanged; add `rules.review_tier_by_risk`: `{ "low": "mid", "medium": "mid", "high": "premium", "critical": "frontier" }` and make `runVerification` pick `security_review` only for high/critical (test: risk `medium` → verification dispatch capability is `technical_review`).
- [ ] Commit `feat: call-length target, scoped QA/review, risk-based review tier`.

### Task C4: Spend cap to enforce

- [ ] Precondition from dashboard: ≥ 10 runs since Phase A with `spend_cap_exceeded` data and verified-pass not below the Phase A baseline. Then set `rules.dispatch_spend_cap.mode` to `"enforce"`, update `test_spend_cap_rule` to assert `"enforce"`, update SKILL.md safe defaults, commit `feat(method): enforce per-dispatch spend cap`. Merge phase C, remove the worktree, `./install.sh`.

---

## Phase D — Resilience and isolation

Worktree: `.worktrees/economics-d` on `feat/economics-phase-d`, removed after merge.

### Task D1: Capacity probe and fallback chains

**Files:** `orchestrator/method.json` (`rules.fallback_chains`), create `bridge/extensions/orchestrator/capacity.ts` + test, modify `index.ts` (before dispatch; reuse `/orchestrator-models --check` probe code).

**Interfaces:** `substituteUnavailable(adapter: Adapter, unavailable: Set<string /*provider*/>, chains: Record<Tier, string[]>, table: AliasTable): { adapter: Adapter; degraded: Array<{ capability: string; from: string; to: string }> }`.

`fallback_chains`:

```json
"fallback_chains": {
  "cheap":    ["gpt-6-luna", "humain-node/qwen3.8-27b"],
  "mid":      ["sonnet-5", "gpt-6-sol", "humain-node/minimax-m3"],
  "premium":  ["opus-5-5", "gpt-6-sol", "humain-node/glm-5.2"],
  "frontier": ["fable-5-1", "astra", "humain-node/glm-5.2"]
}
```

- [ ] **Step 1: Failing test** — adapter with `lead: amazon-bedrock/...opus-5-5` and `unavailable = {"amazon-bedrock"}` and a table containing `humain-node/glm-5.2` → `lead` becomes `humain-node/glm-5.2`, one degraded entry; a capability with no available chain member stays unchanged and is reported as `{ to: "" }`.
- [ ] **Steps 2–5:** implement; probe distinct providers once per run with a one-turn "reply OK" dispatch on the cheapest bound model per provider (cost billed as triage overhead); emit `route_degraded` per substitution; abort the run with a clear message if a lead capability has no available model. Commit `feat: capacity probe and tier fallback chains`.

### Task D2: Worktree per mutating child, with guaranteed cleanup

**Files:** create `bridge/extensions/orchestrator/worktree-isolation.ts` + test (uses real `git` in a temp repo); modify `dispatchParallel`/`runSubagentProcess` call sites for capabilities whose persona can mutate; `installDispatchReaper` startup sweep.

**Interfaces:**
- `createTaskWorktree(repoRoot: string, runId: string, taskId: string): { path: string; branch: string }` → `git worktree add -b orch/<runId>/<taskId> <repo>/.worktrees/orch-<runId>-<taskId> HEAD`
- `integrateTaskWorktree(repoRoot, wt, patchDir): { merged: boolean; patchPath?: string }` → commits any changes in the worktree, attempts `git merge --ff-only` (else `git cherry-pick` of the task commits); on conflict aborts, writes `git diff HEAD...<branch>` to `<patchDir>/<taskId>.patch`.
- `removeTaskWorktree(repoRoot, wt): void` → `git worktree remove --force` then `git branch -D` **only after** merged or patch written.
- `sweepOrphanWorktrees(repoRoot, isTerminal: (runId: string) => boolean, patchDir: string): string[]`.

- [ ] **Step 1: Failing tests** (temp git repo fixture):
  1. worktree created, file changed, integrate → merged, file present on main branch, worktree dir gone, branch gone;
  2. conflicting change on main → `merged: false`, patch file exists and applies with `git apply --check` on the task base, worktree removed;
  3. sweep with `isTerminal` false → nothing removed; with true → removed after patch saved;
  4. crash simulation: worktree exists with uncommitted change and no merge → sweep writes patch before removal.
- [ ] **Steps 2–5:** implement; wire so each implementer child's `cwd` is its worktree, integration runs after the child finishes (success or failure), removal is in a `finally`; on cancellation run integrate-as-patch then remove; startup sweep runs in the extension's activation path. Emit `worktree_integrated` `{task_id, merged, patch_path}`. Commit `feat: isolated self-cleaning implementer worktrees`. Merge phase D, remove the worktree, `./install.sh`.

---

## Phase E — Evidence and pricing

Worktree: `.worktrees/economics-e` on `feat/economics-phase-e`, removed after merge.

### Task E1: Quality evidence, run closure, instrumentation cleanup

- [ ] `runVerification` emits `quality_evidence_score` (1.0 all deterministic checks + review passed; 0.5 checks passed, review findings non-blocking; 0.0 failed) on its `verification_result` event; test in `index.test.ts` with fake verification output.
- [ ] Add `cli.py sweep-runs --stale-hours 24`: marks runs with no terminal event and no event for 24h as `run_abandoned`; idempotent; tests with temp root (a 25h-old incomplete run → abandoned; a 1h-old → untouched; second invocation appends nothing). Wire it into the ingest launchd job.
- [ ] For each of `review_wait_ms`, `context_packet`, `decision_invalidated`, `merge_conflict`, `shadow_review`: either emit it (merge_conflict from D2's `worktree_integrated.merged=false`; context_packet from C2's lead prompt when recon evidence is attached) or remove its card from the dashboard; `test_dashboard_metrics` asserts no card is labelled "not instrumented".
- [ ] Commit `feat: quality evidence, stale-run sweep, instrumentation cleanup`.

### Task E2: Cohorts that can reach `min_samples`, 2% exploration

- [ ] `history.py` cohort key becomes `(task_class, complexity_bucket, risk, capability_tier)`; test: 5 runs differing only in effort and topology fall into one cohort and `history_sufficient` is true.
- [ ] Enable exploration at 0.02 for `risk == "low"` in `config.json` features; test deterministic assignment by run id (same run id → same decision).
- [ ] Commit `feat: coarser cohorts and low-risk exploration`.

### Task E3: Verify every price rate

**Files:** `orchestrator/config.json` (pricing rows), `orchestrator/pricing.py`, `orchestrator/dashboard.py`, `tests/test_cost_attribution.py`.

- [ ] For every model row in `config.json` pricing, fetch the provider pricing page (Anthropic/Bedrock pricing, OpenAI pricing) and record `input`, `output`, `cache_read`, `cache_write`, `source_url`, `verified_on` (ISO date). Rows that cannot be verified keep values and get `"verified_on": null`.
- [ ] Add the program models missing from the table: `gpt-6-luna`, `gpt-6-sol`, `claude-opus-5-5`, `claude-fable-5-1`.
- [ ] Test: every pricing row has `source_url` and `verified_on` keys; dashboard `rate_provenance.models[*].verified_on` is populated from the row; a row with `verified_on: null` renders as "unverified".
- [ ] Commit `chore(pricing): verified rates with provenance`.

### Task E4: Replace the stale ROI claim

- [ ] Extend `scripts/skill_vs_baseline.py` with `--since <iso> --until <iso>` to compare two matched windows (before program vs after Phase A) by cohort, reporting runs, verified pass rate, cost per verified pass, p50/p90 duration, and coverage; refuse to print a savings number when either window has < 10 verified runs or < 80% priced runs.
- [ ] Write the result into `policy_overlay.json` `enforcement.measured_roi` with `window`, `sample_sizes`, `coverage`, and remove the old sonnet-flat counterfactual fields.
- [ ] Test the refusal rule and the window filter with synthetic metrics.
- [ ] Commit `feat: matched-window ROI measurement`. Merge phase E, remove the worktree, `./install.sh`, regenerate the dashboard, and report the before/after table from the spec's evidence section.

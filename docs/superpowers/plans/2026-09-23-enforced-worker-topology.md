# Enforced Worker Topology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make complexity-5-and-higher orchestrations execute, account for, and report parent-owned reconnaissance workers before a lead runs.

**Architecture:** Extract pure recon-policy and evidence-packet helpers so they can be tested without terminal APIs. `dispatchHierarchical()` will dispatch the derived recon tasks through the existing direct subprocess path, capture their costs like architect/lead calls, and pass their bounded output to the lead. The existing `dispatch-outcome` recovery module remains the pure boundary for valid terminal child results that outlive a teardown error.

**Tech Stack:** TypeScript, Bun test, existing HUMAIN Terminal extension APIs, Python pytest.

**Spec:** `docs/superpowers/specs/2026-09-23-enforced-worker-topology-design.md`

## Global Constraints

- Derive Rule-2 thresholds, worker count, capability, and skip classes from `orchestrator/method.json`; do not duplicate policy constants.
- Recon workers are read-only: no editing, committing, pushing, branch switching, stashing, or worktree changes.
- Treat parent-owned recon calls as authoritative for worker progress/cost; do not claim nested lead workers are tracked.
- Preserve the existing conservative terminal-result recovery behavior: only a settled `stop` result with final text may recover from a later non-zero child exit.
- Keep the change within `bridge/extensions/orchestrator/`, its README, and associated tests.

## Review Focus

- A complexity-5 run must dispatch exactly three recon workers even if topology reports a different worker count.
- `investigation` and `qa_verification` runs must not dispatch Rule-2 recon workers.
- A recon worker failure must remain visible to the lead and operator without preventing independent workers from completing.
- Long recon output must not inflate the lead prompt beyond the evidence cap.
- Recovered teardown exits must still appear as raw-process diagnostics while yielding a successful effective dispatch result.

---

### Task 1: Add pure Rule-2 recon planning and evidence formatting

**Files:**
- Create: `bridge/extensions/orchestrator/recon.ts`
- Create: `bridge/extensions/orchestrator/recon.test.ts`
- Modify: `bridge/extensions/orchestrator/index.ts` (import and use helper types)

**Interfaces:**
- Consumes: `METHOD.rules.pre_implementation_recon`, task class, complexity, original goal, and completed dispatch-shaped output.
- Produces: `planReconTasks(input): ReconTaskPlan[]` and `formatReconEvidence(results, maxChars): string`.

- [ ] **Step 1: Write the failing Rule-2 planning tests**

```ts
test("plans three independent read-only recon tasks at complexity 5", () => {
  const tasks = planReconTasks({ method: methodWithRule2, complexity: 5, taskClass: "implementation", goal: "repair flow", runId: "run" });
  expect(tasks).toHaveLength(3);
  expect(tasks.map((task) => task.capability)).toEqual(["implementation_fast", "implementation_fast", "implementation_fast"]);
  expect(tasks.map((task) => task.task)).toEqual(expect.arrayContaining([
    expect.stringContaining("Do not edit, commit, push"),
    expect.stringContaining("affected files"),
    expect.stringContaining("existing tests"),
  ]));
});

test.each([[5, 3], [6, 3], [7, 4], [8, 4], [9, 5], [10, 5]])(
  "derives %i recon workers from Rule 2", (complexity, expected) => {
    expect(planReconTasks({ method: methodWithRule2, complexity, taskClass: "implementation", goal: "x", runId: "run" })).toHaveLength(expected);
  },
);

test.each(["investigation", "qa_verification"])("skips Rule-2 recon for %s", (taskClass) => {
  expect(planReconTasks({ method: methodWithRule2, complexity: 8, taskClass, goal: "x", runId: "run" })).toEqual([]);
});
```

- [ ] **Step 2: Run the recon test to verify it fails**

Run: `cd bridge/extensions/orchestrator && bun test recon.test.ts`

Expected: FAIL because `recon.ts` and `planReconTasks` do not exist.

- [ ] **Step 3: Write the failing evidence formatting tests**

```ts
test("includes completed worker evidence and failed worker diagnostics", () => {
  const evidence = formatReconEvidence([
    { taskId: "run-recon-0", exitCode: 0, stdout: "affected: src/a.ts", stderr: "" },
    { taskId: "run-recon-1", exitCode: 1, stdout: "", stderr: "Error: unavailable" },
  ], 500);
  expect(evidence).toContain("run-recon-0");
  expect(evidence).toContain("affected: src/a.ts");
  expect(evidence).toContain("run-recon-1 unavailable");
  expect(evidence).toContain("Error: unavailable");
});

test("bounds each recon evidence packet and aggregate output", () => {
  const evidence = formatReconEvidence([{ taskId: "run-recon-0", exitCode: 0, stdout: "x".repeat(5_000), stderr: "" }], 120);
  expect(evidence.length).toBeLessThanOrEqual(120);
  expect(evidence).toContain("truncated");
});
```

- [ ] **Step 4: Implement the minimal pure helpers**

```ts
export function planReconTasks(input: ReconPlanInput): ReconTaskPlan[] {
  if (input.complexity < input.method.min_complexity || input.method.skip_for_task_classes.includes(input.taskClass)) return [];
  const count = input.method.workers_by_complexity.find(({ min, max }) => input.complexity >= min && input.complexity <= max)?.workers ?? 0;
  return RECON_QUESTIONS.slice(0, count).map((question, index) => ({
    taskId: `${input.runId}-recon-${index}`,
    capability: input.method.worker_capability,
    task: readOnlyReconPrompt(input.goal, question),
  }));
}
```

Implement byte/character-safe truncation with an explicit truncation marker and include both successful evidence and summarized failed-worker diagnostics.

- [ ] **Step 5: Run the focused recon tests to verify they pass**

Run: `cd bridge/extensions/orchestrator && bun test recon.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the pure recon helper**

```bash
git add bridge/extensions/orchestrator/recon.ts bridge/extensions/orchestrator/recon.test.ts
git commit -m "feat(orchestrator): plan required recon workers"
```

### Task 2: Dispatch recon from the bridge and hand evidence to leads

**Files:**
- Modify: `bridge/extensions/orchestrator/index.ts: dispatchHierarchical(), leadPrompt()`
- Modify: `bridge/extensions/orchestrator/index.test.ts`
- Test: `bridge/extensions/orchestrator/recon.test.ts`

**Interfaces:**
- Consumes: `ReconTaskPlan[]`, existing `dispatchParallel()`, `captureDispatchCost()`, and `formatReconEvidence()`.
- Produces: populated `workerResults` from `dispatchHierarchical()` and a lead prompt containing `Recon evidence`.

- [ ] **Step 1: Write the failing integration-shape test**

Export a narrow pure wrapper only if needed and test the externally observable task preparation rather than spawning terminal processes:

```ts
test("adds completed recon evidence to the lead prompt", () => {
  const prompt = buildLeadPrompt({
    goal: "repair flow",
    plan: planFixture,
    adapter: adapterFixture,
    reconEvidence: "### run-recon-0\naffected: src/a.ts",
  });
  expect(prompt).toContain("Recon evidence");
  expect(prompt).toContain("affected: src/a.ts");
  expect(prompt).toContain("Do not repeat broad repository discovery");
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `cd bridge/extensions/orchestrator && bun test index.test.ts recon.test.ts`

Expected: FAIL because the lead-prompt builder does not accept evidence yet.

- [ ] **Step 3: Implement parent-owned recon dispatch**

In `dispatchHierarchical()`:

```ts
const reconTasks = planReconTasks({ method: METHOD.rules.pre_implementation_recon, complexity: plan.complexity, taskClass: plan.task_class, goal, runId });
ACTIVE_RUN?.setPhase(`recon: 0/${reconTasks.length} starting`);
const workerResults = await dispatchParallel(cwd, runId, reconTasks, adapter, ctx);
for (const result of workerResults) await captureDispatchCost(captureOpts, result);
const reconEvidence = formatReconEvidence(workerResults, RECON_EVIDENCE_MAX_CHARS);
ACTIVE_RUN?.setPhase(`recon: ${workerResults.filter((r) => r.exitCode === 0).length}/${reconTasks.length} completed; dispatching lead(s)`);
```

Pass the evidence to every lead prompt. If no Rule-2 task applies, use a phase that correctly states no parent-owned recon is required. If all recon calls fail, include an explicit degraded-evidence notice instead of hiding the failures.

- [ ] **Step 4: Update lead instructions**

Replace the unconditional “workers fan out inside each lead” messaging with wording that reports actual completed parent-owned recon packets. Retain nested subagent guidance only for implementation, review, and QA; state those nested calls are not authoritative worker accounting.

- [ ] **Step 5: Run the focused bridge tests to verify they pass**

Run: `cd bridge/extensions/orchestrator && bun test index.test.ts recon.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the bridge integration**

```bash
git add bridge/extensions/orchestrator/index.ts bridge/extensions/orchestrator/index.test.ts bridge/extensions/orchestrator/recon.ts bridge/extensions/orchestrator/recon.test.ts
git commit -m "feat(orchestrator): dispatch recon before leads"
```

### Task 3: Include worker results in final accounting and documentation

**Files:**
- Modify: `bridge/extensions/orchestrator/index.ts` (orchestration command finalization)
- Modify: `bridge/extensions/orchestrator-README.md`
- Modify: `bridge/extensions/orchestrator/index.test.ts`

**Interfaces:**
- Consumes: `workerResults` returned by `dispatchHierarchical()`.
- Produces: final billed-result list and operator summary containing parent-owned recon counts/costs.

- [ ] **Step 1: Write the failing accounting test**

Extract a pure `collectBilledResults()` helper if necessary:

```ts
test("includes parent-owned worker results in billed dispatches", () => {
  const billed = collectBilledResults({ architectResult: architect, workerResults: [worker], leadResults: [lead], verificationResults: [], escalationResults: [] });
  expect(billed).toEqual([architect, worker, lead]);
  expect(billed.reduce((total, result) => total + result.costUsd, 0)).toBe(0.42);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `cd bridge/extensions/orchestrator && bun test index.test.ts`

Expected: FAIL because worker results are omitted from the billed list.

- [ ] **Step 3: Implement accounting and summary changes**

Destructure `workerResults` at the command call site, include it in `billedResults`, and add an explicit final-summary line:

```ts
`recon workers: ${successfulRecon}/${workerResults.length} completed · $${reconCost.toFixed(4)}`,
```

Use `summarizeStderr()` rather than raw stderr slices for any failed recon summary. Update README topology and progress/log documentation to describe parent-owned recon and the limitation on nested lead-created children.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `cd bridge/extensions/orchestrator && bun test index.test.ts recon.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit accounting and documentation**

```bash
git add bridge/extensions/orchestrator/index.ts bridge/extensions/orchestrator/index.test.ts bridge/extensions/orchestrator-README.md
git commit -m "fix(orchestrator): report actual recon workers"
```

### Task 4: Validate terminal-result recovery and the complete change

**Files:**
- Modify only if failures reveal an implementation defect: `bridge/extensions/orchestrator/dispatch-outcome.ts`, `bridge/extensions/orchestrator/dispatch-outcome.test.ts`, `bridge/extensions/orchestrator/index.ts`

**Interfaces:**
- Consumes: `classifyDispatchOutcome()` and `summarizeStderr()`.
- Produces: recovered dispatch result with effective zero exit code but retained raw-exit diagnostic.

- [ ] **Step 1: Run the recovery test suite first**

Run: `cd bridge/extensions/orchestrator && bun test dispatch-outcome.test.ts`

Expected: PASS. If it fails, add the smallest failing regression test before changing implementation.

- [ ] **Step 2: Run all bridge tests**

Run: `cd bridge/extensions/orchestrator && bun test`

Expected: PASS with no failures.

- [ ] **Step 3: Run the extension typecheck/build used by the repository**

Run: inspect the repository’s documented bridge validation command; if none exists, run:

```bash
cd bridge/extensions/orchestrator && bunx tsc --noEmit --strict --module esnext --moduleResolution bundler --target es2022 --skipLibCheck --allowImportingTsExtensions --resolveJsonModule *.ts
```

Expected: exit code 0.

- [ ] **Step 4: Run the Python suite**

Run: `python3 -m pytest tests -q`

Expected: PASS.

- [ ] **Step 5: Inspect the final diff and commit the completed implementation**

```bash
git diff --check
git status --short
git add bridge/extensions/orchestrator docs/superpowers
git commit -m "fix(orchestrator): enforce observable worker recon"
```

Do not include unrelated files. If earlier task commits were made, use this final commit only for any remaining integration/verification corrections.

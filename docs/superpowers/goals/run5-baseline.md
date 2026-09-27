# Run 5 baseline

- **Commit:** `45964e7` (`feat/lead-ci-wait`)
- **Date:** 2026-09-27
- **Pytest:** `python3 -B -m pytest -p no:cacheprovider -q` — 1119 passed, 1 skipped; exit 0 (110s).
- **Bun:** `bun test ./bridge` (run alone, from worktree root) — 1648 pass, 3 fail, 1651 tests across 60 files; exit 1 (82s).

The three deterministic failures in the full run:

1. `runSubagentProcess process/event handling > long minified-bundle-style source line surfaces the sentinel and a stack frame through a real Node parent` (`dispatch/child-process.test.ts:814`; “Node driver failed: Bundle failed”)
2. `session ingest hook wiring > recordHookFailure's written status has exactly the fields contract.json's ingest_status.fields declares (B4.7)` (`TypeError: undefined is not an object (evaluating 'contract.redaction_regex.ts')` family)
3. `session ingest hook wiring > redactPaths matches contract.json's ts redaction_regex on a sample` (`TypeError: undefined is not an object (evaluating 'contract.redaction_regex.ts')`)

All three pass in isolation: `bun test hooks/ingest.test.ts dispatch/child-process.test.ts` → 50 pass; `bun test index.test.ts` → 314 pass; ingest and index together from root → 322 pass. These are cross-file state pollution/ordering in the full run, not defects in the tests' subjects. Cause not isolated and not fixed in this run (fix-only-if-small-and-clear rule).

These differ from the three names the run-4 retry lead reported (live-qa perf, duplicate-named test in `index.test.ts`, and `run/session.test.ts`); those did not fail in this baseline.

A first full run executed concurrently with pytest showed two additional load-sensitive failures — `REVIEW ROUND 3 / WARNING: a fallback target's persisted log reserves room for both the content cap and the interruption notes` and `BLOCKING 2: a detached grandchild that escapes the process group ...`. These are timing flakes under CPU contention, not new failures.

**Green for run 5** = no failures beyond this list.

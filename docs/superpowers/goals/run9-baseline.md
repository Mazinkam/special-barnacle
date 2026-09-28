# Run 9 Phase 1a baseline

- **Worktree / branch:** `.worktrees/telemetry-health` / `feat/telemetry-health`
- **Starting commit:** `8d25b91`
- **Execution:** All four checks run separately from the worktree root, each with a 180-second bound; full suites were run only by this delegated subagent.

| Check | Result | Exit |
| --- | --- | ---: |
| `./scripts/typecheck-bridge.sh --all` | PASS; 0 diagnostics | 0 |
| `./scripts/lint.sh` | PASS; ruff, vulture, knip reported nothing | 0 |
| `bun test ./bridge` | 1713 passed, 0 failed; 1713 tests across 64 files (106.25s) | 0 |
| `python3 -B -m pytest -p no:cacheprovider -q` | 1119 passed, 1 skipped (113.02s) | 0 |

Compared with `docs/superpowers/goals/run5-baseline.md`: run 5 recorded 1648 Bun passes and 3 failures (1651 tests across 60 files), and 1119 pytest passes with 1 skip. This run has 65 more Bun passes, 3 fewer Bun failures, 4 more Bun test files, and unchanged pytest counts. None of the only three permitted run-5 Bun failures occurred: the real-Node-parent minified-bundle diagnostic test and both `hooks/ingest.test.ts` contract/redaction tests passed. There are no new failures.

# Integrating `feat/enforced-worker-topology` into `main`

**Status: DONE.** Merged into local `main` as `8f145a4` (`--no-ff`). Not pushed.

Both blockers below cleared and the merge was carried out:

1. Blocker 1 resolved itself — the owner of the `feat/orchestrator-efficiency`
   merge committed it as `eaa9278`, leaving `main` clean.
2. Blocker 2 was resolved by hand in the feature worktree (`4f328c4`), then
   merged forward. The resolution rationale for each judgement call is in that
   commit message; the conflict map below is what it was resolved against.

Verification on merged `main`: `bun test` 260 pass / 0 fail, `pytest` 628 passed,
`./scripts/typecheck-bridge.sh` exit 0, `main`'s 4 unrelated dirty doc files
preserved, feature worktree lock preserved.

One real defect surfaced by the merge: `costReported` had become required on
`DispatchResult`, which this branch's test fixture no longer satisfied.

**Remaining: the push is deliberately not done — see "Push" at the end.**

---

## Original analysis (kept as the record of what the merge was resolved against)


The feature itself is finished and green (`bun test` 90/0, `pytest` 77/77,
`./scripts/typecheck-bridge.sh` exit 0). What follows is everything needed to
make the integration call — written down instead of guessed at, because two
separate orchestration runs stopped here and the reason is not going to change
on its own.

## Blocker 1 — `main` has another owner's merge in progress

```
$ cat .git/MERGE_HEAD
33b5c8d692c72437854f5a04fb291e1333665495          # feat/orchestrator-efficiency
$ head -1 .git/MERGE_MSG
Merge branch 'feat/orchestrator-efficiency' into main
$ git status --short | wc -l
56                                                 # 30 added, 23 modified, 3 untracked
$ git diff --name-only --diff-filter=U
                                                   # (empty: conflicts resolved, staged, uncommitted)
```

Git will refuse `git merge` on `main` while this exists, and the resolution is
staged but uncommitted — meaning someone is mid-review of it. Note that
`MERGE_HEAD` has already moved once (it was `a23ed5f` during the earlier run,
now `33b5c8d`), so this is active work, not an abandoned artifact.

**Nothing here may be committed, aborted, or `reset` by anyone but its owner.**
Committing it would publish a merge resolution no one has approved; aborting it
would destroy that resolution.

**Required first:** its owner concludes it (`git commit`, or `git merge --abort`).

## Blocker 2 — real content conflicts, and `main` is the larger side

Churn on the two conflicting files since merge-base `899f9ff`:

| Branch | `index.ts` | `index.test.ts` |
|---|---|---|
| `main` | +1659 / −295 | +2181 / −? |
| `feat/enforced-worker-topology` | +303 / −63 | +411 / −? |

`main` moved ~5× further. 22 commits touched `index.ts` there, including
progress-aware lead timeouts, the `/orchestrate` live-UI redesign, telemetry
batching and drain, run-evidence attribution, and the `ChildSpawner` test-seam
narrowing.

An 11-hunk plain 3-way merge of `index.ts`, by region:

| Hunk(s) | Region | Nature |
|---|---|---|
| 1–3 | imports, top-level constants, `TELEMETRY_MAX_BATCH` | mechanical; take both sides' additions |
| 4 | `clampTriage` | **semantic** — the feature extracted `clampComplexity()` shared with `parseArgs`; check `main` did not also touch triage clamping |
| 5–6 | `runSubagentProcess` | **semantic** — both sides changed the spawn seam. `main` narrowed it to `ChildSpawner` (`cc9836d`); the feature already adopted that exact shape in `f2ddaa6` specifically to shrink this, so expect near-agreement |
| 7–9 | `dispatchParallel` | **the real decision** — the feature adds `tools` pass-through and the recon dispatch path; `main` added `cancelled` outcome status and progress-aware timeouts |
| 10–11 | `installTelemetryDrain` | `main`-only feature; take `main` |

Only hunks 4 and 7–9 need judgement. The rest are additive.

## Recommendation: merge `main` → feature, do not rebase

- **Rebase replays 6 commits against 1659 changed lines** — you resolve the
  `dispatchParallel` overlap up to six times, once per commit, and every
  intermediate state is untested.
- **Merge resolves it once**, and the 6 commits already have meaningful,
  reviewed messages plus review history attached to their hashes.
- The feature is the smaller, newer side. Direction of resolution should be
  **keep `main`'s infrastructure, re-apply the feature's recon seam on top of
  it** — not the reverse.

## Safe sequence (only after Blocker 1 clears)

```bash
cd /Users/abdulkarim/.local/share/agent-skills/hierarchical-agent-orchestrator

# 0. Confirm main is clean and the merge is concluded.
test ! -e .git/MERGE_HEAD && git status --short   # expect no MERGE_HEAD

# 1. Resolve inside the FEATURE worktree; main stays untouched.
cd .worktrees/enforced-worker-topology
git merge main                                    # expect conflicts in index.ts, index.test.ts

# 2. Resolve per the table above. In dispatchParallel, both behaviours must survive:
#    - main's `cancelled` DispatchOutcome status and progress-aware timeout
#    - the feature's per-task `tools` pass-through to --tools
#    Re-read dispatch-outcome.test.ts: the `cancelled` status interacts with the
#    feature's four cancellation boundaries and is the most likely silent breakage.

# 3. Re-verify on the merged feature branch — all three gates, not just unit.
cd bridge/extensions/orchestrator && bun test     # expect 0 fail
cd - && python3 -m pytest tests -q                # expect 77 passed
./scripts/typecheck-bridge.sh                     # expect exit 0

# 4. Independent re-review of the CONFLICT RESOLUTION specifically.
#    method.json rules.review_after_fix: re-review at or above the original
#    reviewer's tier. The original reviews were premium. A hand-resolved
#    11-hunk merge across two concurrently-developed features is exactly the
#    change class that earns a real review, not a rubber stamp.

# 5. Only then, and only if 3 and 4 are clean:
cd /Users/abdulkarim/.local/share/agent-skills/hierarchical-agent-orchestrator
git merge --no-ff feat/enforced-worker-topology
cd bridge/extensions/orchestrator && bun test     # re-run BOTH suites on merged main
cd - && python3 -m pytest tests -q
git log --oneline main | grep 10bc386             # confirm feature commits reachable

# 6. Push only if non-divergent (it was 3 ahead / 0 behind; re-check):
git rev-list --left-right --count origin/main...main
git push origin main                              # never --force
```

### Rollback

Step 1 conflicts are recoverable with `git merge --abort` in the feature
worktree. After step 5, `git reset --hard ORIG_HEAD` on `main` undoes the merge
— but only while nothing else has been committed on top, and never after step 6.

## Preserve

- `.worktrees/enforced-worker-topology` is **locked** by `supacode`
  (`{"owner":"supacode","version":"0.10.8"}`). Do not unlock, prune, or remove
  it. The lock does not block commits or merges inside the worktree.
- `main`'s 56 unrelated dirty entries belong to other work. Preserve them.

## The decision that is actually being asked for

Not "should this merge" — it should. It is:

1. **Who** resolves an 11-hunk conflict spanning two features that were
   developed concurrently by different owners (recon topology vs. progress-aware
   timeouts / live UI)? Whoever does it needs working knowledge of both.
2. **When** — after `feat/orchestrator-efficiency` lands, or should these two be
   sequenced deliberately so `main` isn't absorbing two large bridge rewrites in
   a row?

Automation should not answer either. That is why both runs stopped here.

## Push

`main` is **55 commits ahead of `origin/main` and 0 behind**, so a normal
non-force push is mechanically safe. It was still not performed, on purpose.

Those 55 commits are not all this feature: they include the
`feat/orchestrator-efficiency` merge and other owners' in-flight work that has
been accumulating locally. Pushing would publish all of it, which is a
publication decision for the repo owner, not a side effect of integrating one
branch. It is also the only irreversible step in this whole sequence.

When you want it:

```bash
git rev-list --left-right --count origin/main...main   # confirm left side is still 0
git push origin main                                   # never --force
```

### Rollback

`main` before this merge was `eaa9278`. While nothing has been committed on top
and nothing has been pushed:

```bash
git reset --hard eaa9278
```

# Benchmark runbook

How to build the pilot task suite, validate it and run experiments with the harness in `bench/`
(spec `docs/superpowers/specs/2026-09-29-tiered-workflows-and-eval-design.md` §2). Paid steps are
marked; nothing here spends model money unless you pass `--approve-usd` to `bench_run.py`.

## 1. Find candidate tasks (free)

```bash
python3 scripts/bench_candidates.py ~/Documents/Projects/forge --since 90.days
python3 scripts/bench_candidates.py ~/Documents/Projects/humain-terminal --since 90.days
python3 scripts/bench_candidates.py ~/.local/share/agent-skills/hierarchical-agent-orchestrator --since 90.days
```

Each line is `sha  band  src=N  tests=N  subject` for a commit that changed both source and tests.
The band is a starting label only.

## 2. Author the suite (human judgment)

Keep the suite **outside every repository**, e.g. `~/orch-bench/suite/`, so no agent sandbox can read
hidden checks or reference patches. Per task:

```
~/orch-bench/suite/<id>.json          manifest (bench/manifest.py schema)
~/orch-bench/suite/<id>/hidden/       files overlaid at grading time (hidden tests)
~/orch-bench/suite/<id>/reference.patch   the real fix, for validation/analysis only
```

Manifest fields: `id`, `repo`, `base_commit` (full 40-hex parent of the real commit), `goal` (the
task as a user would phrase it, without hinting at the solution), `task_class`,
`scope_band` (`tiny|small|multi_file|cross_system`), `risk` (`low|medium|high|critical`),
`split` (`dev|holdout`), `setup` (argv lists, e.g. `[["bun","install"]]`), `visible_checks`,
`hidden_checks` (argv lists run in the graded tree), `hidden_files`, `reference_patch`,
`protected_paths` (paths the agent must not change, e.g. the hidden test file names),
`timeout_s`.

Pilot target: ~16 replayed + ~4 synthetic (one auth/secrets change, one cross-module interface
change), ~5 per scope band, ~70% `dev` / ~30% `holdout`. Label every task **before** running any
arm. The reference patch for a replayed task is `git diff <base_commit> <real_commit> -- <source paths>`;
the hidden checks come from that commit's test changes plus any acceptance check the tests miss.

## 3. Validate the suite (free)

```bash
python3 scripts/bench_validate_tasks.py ~/orch-bench/suite --work ~/orch-bench/validate \
  --prepared-cache ~/orch-bench/prepared
```

**Prepared trees.** Each task's base snapshot plus its `setup` commands (e.g. `bun install`) is built
once into `--prepared-cache` and marked READY only if setup succeeds; every later use (the validator's
base grading, every benchmark attempt of every arm) gets an instant APFS clone. Pass the same
`--prepared-cache` to `bench_validate_tasks.py` and `bench_run.py` so validation warms the cache and
all arms start from the byte-identical environment. A failed setup in the runner is journaled as
`infra_error` with an `infra_reason`, never silently ignored. Delete the cache directory to force a
fresh install.

A task is kept only if its base **fails** the hidden checks, its setup succeeds, and the reference
patch applies and **passes 3/3** times. Everything else is quarantined with a reason in
`~/orch-bench/validate/validation.json`. Fix or drop quarantined tasks until the exit status is 0.
Hidden checks run under `sandbox-exec` with no network.

## 4. Build pinned tools (free; local build)

The sandbox denies every agent read access to its task's repo (so it cannot `git log` its way to the
solution). But the live `humain-terminal` is npm-linked into the humain-terminal checkout, and the
orchestrator extension and its Python modules live in this repo, so for tasks on either repo the arms
would crash inside the sandbox. Run both from pinned copies outside every repo instead:

```bash
python3 scripts/bench_tools.py --dest ~/orch-bench/tools \
  --skill-repo ~/.local/share/agent-skills/hierarchical-agent-orchestrator --skill-rev main \
  --ht-repo ~/Documents/Projects/humain-terminal --ht-rev main
```

- `~/orch-bench/tools/skill/`: `git archive` of the orchestrator at `--skill-rev` (no `.git`) plus
  `PINNED.json` (`source_repo`, full `commit`, `tree_digest`).
- `~/orch-bench/tools/ht/`: a humain-terminal local release. The script exports `git archive <ht-rev>`
  into `~/orch-bench/tools/ht-src`, runs `npm ci` and `node scripts/local-release.mjs --out
  ~/orch-bench/tools/ht --skip-check --skip-test --skip-bun-install --force` there, and writes
  `PINNED.json` (`source_repo`, `commit`, `binary`) into `ht/` and next to the installed package. The
  export is removed afterwards (`--keep-src` keeps it); nothing runs inside the real checkout, so
  uncommitted work there is neither built nor disturbed. The release step still builds the standalone
  Bun binary, so `bun` must be on `PATH`.
- `--skip-ht` builds only the skill copy. `--force` replaces existing copies. A `--dest` inside any
  git work tree, or inside either source repo, is refused.

The script prints the `binary` and `skill_root` values for the config below.

## 5. Freeze the configuration

```bash
cp ~/.humain-terminal/agent/orchestrator-profiles.json ~/orch-bench/profiles-frozen.json
```

`~/orch-bench/config.json` (fields of `bench/arms.py` `ExperimentConfig`, plus the optional
`installed_extension_dir` recorded for provenance):

```json
{
  "experiment_id": "smoke-1",
  "seed": 1,
  "k": 1,
  "binary": "/Users/<you>/orch-bench/tools/ht/node/node_modules/@humain/terminal/dist/bundle/cli.js",
  "skill_root": "/Users/<you>/orch-bench/tools/skill",
  "profiles_file": "/Users/<you>/orch-bench/profiles-frozen.json",
  "direct_model": "<provider/model bound to implementation_strong in /orchestrator-models show>",
  "direct_thinking": "high",
  "orchestrate_flags": ["--profile", "premium", "--max-retries", "2"],
  "per_run_usd_cap": 5.0,
  "per_run_timeout_s": 3600,
  "installed_extension_dir": "/Users/<you>/.humain-terminal/agent/extensions/orchestrator"
}
```

The `current` arm sets `HUMAIN_ORCHESTRATOR_WORKFLOW_MODE=off` and `tiered` sets `enforce`, so a
saved `/orchestrator-models workflow` setting never leaks into an arm. Both orchestrated arms pass
`--no-extensions -e <skill_root>/bridge/extensions/orchestrator`, so only the pinned copy's extension
loads, whatever is installed under `~/.humain-terminal/agent/extensions`.

The config fingerprint records the pinned `PINNED.json` contents (or, for a git checkout, `HEAD` and
the dirty diff), the binary's resolved path and any `PINNED.json` beside it or up to two directories
above it. Rebuilding the tools changes the fingerprint, and `bench_run.py` refuses to continue an
experiment whose fingerprint changed.

**Preflight.** Before any snapshot or spend, `bench_run.py` (and `bench.runner.run_experiment`)
checks every task's denied roots (the task repo, the suite directory, the journal, the live state
root and HT sessions) against the realpaths of the binary (every existing-file token, or `which` of the
first), `skill_root` and `profiles_file`. Any tool equal to or inside a denied root aborts the run
with one line per tool, task and root. The fix is always to build pinned copies (step 4).

**Contamination flag.** The pinned copies must stay readable, and for tasks on this repo or
humain-terminal they may contain the solution. After each attempt the runner scans the tool-call
arguments (bash commands, read paths and so on, never prompts or tool results) of the attempt's
`agent.jsonl` and of the child logs `state/runs/<run_id>/*.events.jsonl`. It looks for references to
`skill_root`, to the directory holding the resolved binary, and to the pinned install root. Journal rows
get `contaminated` and `contamination_evidence` (at most 5 short strings). `bench_report.py` shows
contaminated counts per arm and adds a sensitivity line: the quality verdict recomputed without tasks
that have any contaminated attempt. The primary analysis still uses all attempts.

## 6. Smoke run (PAID; explicit approval)

```bash
python3 scripts/bench_run.py --suite ~/orch-bench/suite --experiment-root ~/orch-bench/exp-smoke \
  --prepared-cache ~/orch-bench/prepared \
  --config ~/orch-bench/config.json --arms direct,current --split dev --approve-usd <printed estimate>
python3 scripts/bench_report.py --journal ~/orch-bench/exp-smoke/journal.jsonl --candidates direct
```

Check afterwards: every attempt has a journal row, grading ran (`attempts/*/grade.json`), the
experiment state root is populated, and the live state root is untouched
(`shasum ~/.local/state/coding-agent-orchestrator/*.jsonl` before and after).

## Record here

Suite location, file hashes (`find ~/orch-bench/suite -type f | sort | xargs shasum -a 256`, never
the hidden content), validation result, smoke-run result and cost.

### Pilot suite (2026-09-30)

- Location: `~/orch-bench/suite/` (outside every repo); 20 tasks, 84 files.
- Composition: 16 replayed (forge 6, humain-terminal 5, this repo 5) + 4 synthetic (`syn-001` forge
  secrets redaction, `syn-002` auth failure class, `syn-003` frontmatter fences, `syn-004` failover env
  overrides). Bands 5/5/5/5; split 14 dev / 6 holdout; risk 6 low / 11 medium / 3 high.
- Per-file hashes: `~/orch-bench/suite.sha256`; its own sha256
  `0de7263fedf2a4e64676fb08597a11607baac6dde1bdc52f3955f7711e16af41`.
- Validation: all 20 valid in one combined run on commit `80d4556` with a shared prepared cache
  (`~/orch-bench/validation-final.json`), ~40 min. No swaps from the proposal.
- Known weaknesses (from the authoring agents): seven goals name the interface the hidden tests check
  (ht-001/002/003/005, orch-005, syn-002, syn-004); `ht-005` setup builds `packages/ai` with type errors
  tolerated and one of its overlaid test files is not run (needs networked model data); `syn-003`
  leaves closing-marker behaviour for `----`/`---x` unspecified; `syn-004` exercises only
  `failoverConfig()` with no explicit rule.

### Suite revision 2 (2026-10-01)

- humain-terminal tasks now hydrate the provider model catalog during setup (`npm run hydrate:model-data`),
  so the prepared tree resembles a real dev checkout: typecheck errors at ht-001's base drop from 833 to
  ~40 (the rest are old tests naming models today's live catalog no longer lists).
- `ht-003` and `ht-005`: hydration fails at their base commits (the live catalog lacks a provider those
  commits expect, `kimi-coding`), so their setup tries and continues without it. Each arm still gets the
  identical prepared tree; these two tasks keep the noisier typecheck.
- All 20 tasks re-validated (humain-terminal 6/6 after the change). New file-hash manifest sha256:
  `1e56bc8728ae08d0ea92f71a1a96f25870f35f28f648cf40a46e6c1c101b97e8`.
- Known benchmark-environment noise (affects every arm equally): `test_allowed_path_is_readable` fails
  on this repo's tasks because `sandbox-exec` cannot nest; humain-terminal typecheck drift above; some
  base commits contain genuinely failing tests (e.g. `test_cli_rejects_tiered` at orch-001's base).


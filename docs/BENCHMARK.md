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
python3 scripts/bench_validate_tasks.py ~/orch-bench/suite --work ~/orch-bench/validate
```

A task is kept only if its base **fails** the hidden checks, its setup succeeds, and the reference
patch applies and **passes 3/3** times. Everything else is quarantined with a reason in
`~/orch-bench/validate/validation.json`. Fix or drop quarantined tasks until the exit status is 0.
Hidden checks run under `sandbox-exec` with no network.

## 4. Freeze the configuration

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
  "binary": "humain-terminal",
  "skill_root": "/Users/<you>/.local/share/agent-skills/hierarchical-agent-orchestrator",
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
saved `/orchestrator-models workflow` setting never leaks into an arm.

## 5. Smoke run (PAID; explicit approval)

```bash
python3 scripts/bench_run.py --suite ~/orch-bench/suite --experiment-root ~/orch-bench/exp-smoke \
  --config ~/orch-bench/config.json --arms direct,current --split dev --approve-usd <printed estimate>
python3 scripts/bench_report.py --journal ~/orch-bench/exp-smoke/journal.jsonl --candidates direct
```

Check afterwards: every attempt has a journal row, grading ran (`attempts/*/grade.json`), the
experiment state root is populated, and the live state root is untouched
(`shasum ~/.local/state/coding-agent-orchestrator/*.jsonl` before and after).

## Record here

Suite location, file hashes (`find ~/orch-bench/suite -type f | sort | xargs shasum -a 256`, never
the hidden content), validation result, smoke-run result and cost.

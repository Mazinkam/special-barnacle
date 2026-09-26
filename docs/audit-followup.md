# Audit follow-up: refactor/modular

Re-check of `~/.local/state/coding-agent-orchestrator/runs/ht-orch-1790329059995-pv435g/lead-report.md` (whose audit was against `main`) against this worktree, with the relevant plan items cross-checked against `docs/architecture-review.md` sections B4–B6 and C3–C7. `fixed-already` means verified in this tree; it does not mean included in this tooling/docs run. Remaining work is assigned to the phase that owns it in the architecture plan.

| ID | Finding | Status | Evidence / reason | Owner phase |
|---|---|---|---|---|
| A1 | `parseFailedChecks` treats passing `0 errors` as failure | fixed-now | Fixed in 8fb3c57, 720b833, ea5055a; also recorded in Fixed-now status updates | B4.7 |
| A2 | ContextRegistry and VerificationCache unlocked read-modify-write | fixed-already | `orchestrator/store/documents.py:6,36,64` documents and takes a sidecar exclusive lock around the document operation | B3 |
| A3 | Unread `config.json` blocks/keys | fixed-already | Modular branch no longer has `orchestrator/config.json` (confirmed absent); no unread blocks remain in that file | B3 |
| A4 | Python child processes lack errors/timeouts; `runCli` dead | fixed-already | `bridge/extensions/orchestrator/adapters/python-cli.ts:78` centralizes spawning; handles spawn error and timeout at lines 132–160; callers use the CLI adapter and no `runCli` declaration remains | C1 |
| A5 | `controls.py` dead in production | fixed-already | `orchestrator/controls.py` docstring documents it as public API; `rg` found nothing claiming it runs in production | B3 |
| A6 | Provider fallback handles quota only | deferred — owned by `feat/model-failover` | Specifically assigned to that branch; not altered here | C2 |
| A7 | `planRun` unvalidated response and hard-coded coupling/parallelizable values | fixed-now | PlanResponse validation in ef683bf; coupling/parallelizable defaults in e3b4a0c | B4.7 |
| A8 | Oversized bridge/Python units, especially orchestrate and subagent dispatch | fixed-already | `bridge/extensions/orchestrator/commands/orchestrate.ts`, `pipeline/`, `dispatch/child-process.ts:362`, and extracted modules demonstrate the split | B3/B4.5 |
| A9a | Dead/test-only code (`runCli`, event-log helper, archive locate helpers, no-op parameter, test aliases, unused imports) | fixed-now | `appendTrimmedEventLog` was deleted in cfb6711 (no production caller); see Phase 2 status for the cleanup details | B3/B4.1 |
| A10a | SKILL/dashboard/README/PUBLISH/method docs disagree with code | fixed-now | SKILL.md 1402271; orchestrator-README batch-queue path 2a53122; PUBLISH table d905b4c; CHANGELOG 4417605 | B6 |
| A10b | Duplicated shared values and vocabulary | fixed-already | `orchestrator/vocab.py:59,111` centralizes terminal task IDs/high-risk vocabulary; TS `expandHome` is centralized at `bridge/extensions/orchestrator/config.ts:55` and used at lines 84–85; shared contract constants live in `orchestrator/contract.py` | B1 |
| A10c | Defaults differ (min samples, lead limits, state-root variables) | fixed-now | MAX_LEADS in 6f2636d; SCHEDULER_MIN_SAMPLES in db7ab6a; state-root env in 2caf00a and 4c8c208 | B4.7/B1 |
| A10d | Declared Python minimum differs from local runtime | fixed-now | `requires-python = ">=3.9"` in 7ace236, README floor e9997a0 | B6 |
| A10e | Agent `model:` front matter not checked against routing | fixed-already | `bridge/extensions/orchestrator/adapters/agents-frontmatter.test.ts:47–63` checks the map and resolved fallback model | B4.3 |
| A10f | Dashboard `import os as os` test patch hook | fixed-already | No such import exists on `refactor/modular`; `rg` confirms | B3 |
| A10g | Prompt/report writes swallow errors; `any` usages | fixed-now | Prompt-write/discovery failures in 87fb1ee; failed report link in 6f6da8b; bridge `any` types in cab688d | B4.7 |
| A10h | Outdated `reconWorkers` duplication claim | fixed-already | Current `bridge/extensions/orchestrator/recon.ts` imports the shared model value; old review claim is stale | B4.7 |
| T1 | Missing direct tests for policy recommendations, run diagnostics, parseFailedChecks | fixed-now | policy_recommendations f87e249; run-diagnostics f95ff6a; parseFailedChecks (B4.7) 720b833/ea5055a | B5/B4.7 |
| T2 | Sleep-based tests may be timing-sensitive | deferred | Sleep-based timing tests were not rewritten in this run; one 5 s timeout seen once under concurrent load in review, passed on rerun; needs a fake-clock pass | B5 |
| T3 | Large bridge and ingest checkpoint test files | fixed-now | index.test.ts split per owning module (0c210f8…b6e3170, 21 commits); tests/ingest_checkpoint/ package a0fdc31 (80 tests, same count) | B5 |
| C3 | Resume a lead after transient provider failure | fixed-now | See Phase 3 status; implemented in ca57c1e, 8549acf, a57198e, e5f9578, d1a052e | C3 |
| C4 | Skip QA if no lead succeeds and ground prompts in repo | fixed-now | See Phase 3 status; fixed in 2d7e285 | C4 |
| C5 | Summary verification state contradictions | fixed-now | See Phase 3 status; fixed in 9f10b6e | C5 |
| C6 | Explicit context/last-reply flags and prompt insertion | fixed-now | See Phase 3 status; fixed in c692f2f, 3a5010e, 5407b9a, 6713923 | C6 |
| C7 | Detect short goals missing context | fixed-now | See Phase 3 status; fixed in 2ba0711, 438844f | C7 |
| B4.6 | Context and missing-context safeguards in bridge | fixed-now | C6/C7 fixed; see Phase 3 status | B4.6 |
| B4.7 | Remaining bridge correctness items (report parsing, duration, plan validation/options, swallowed writes, Python/TS parity) | fixed-now | See Fixed-now status updates table | B4.7 |
| B3-P2 | Remaining Python dead-code/module cleanup (policy recommendations, flaky stats, controls decision, thin CLI wrappers) | deferred | Not in this goal's scope: controls.py kept as documented public API (goal), policy_recommendations now has direct tests (f87e249); flaky-stats and thin-CLI-wrapper cleanup left for a follow-up | B3 Phase 2 |
| B5 | Test-file modularization and explicit fault injection | fixed-now (partial fault injection) | See Phase 4 status | B5 |
| B6 | Documentation cleanup / release-plan notes / Python version alignment | fixed-now | See Phase 4 status | B6 |

## Tool baselines

Date: 2026-09-26. Commands ran from the repository root using `uvx`/`bunx`; no project dependencies were added. These are baseline reports, not clean-pass claims.

### `uvx ruff check .`

Exit 1; **66 diagnostics** (37 marked fixable). Output was 1,076 lines, so truncated here at the required >200-line limit. The full captured output was `/tmp/modular-ruff-baseline.txt` for this session. Representative beginning and ending excerpts:

```text
F401 [*] `dataclasses.dataclass` imported but unused
 --> orchestrator/adaptive.py:3:25
...
Found 66 errors.
[*] 37 fixable with the `--fix` option (1 hidden fix can be enabled with the `--unsafe-fixes` option).
```

### `uvx vulture orchestrator scripts --min-confidence 80`

Exit 3; one finding:

```text
orchestrator/adaptive.py:225: unused variable 'reproducible' (100% confidence)
```

### `bunx knip` baseline

The repo has no `package.json` so knip can't run in place. Baseline run in a temp copy (`bridge/` + `knip.json` + stub `{"name":"probe","private":true,"type":"module"}` `package.json`) on this branch at commit c93d85c: `bunx knip --production` → 0 findings, exit 0; non-production `bunx knip` reports unused exports/types (test-only exports and re-exports) and configuration hints (the @humain/*, @sinclair/typebox, bun:test ignore entries are reported as unnecessary).

Note: `scripts/lint.sh` (end of run) must supply a `package.json` (temp or committed private stub with no dependencies).

The Python packaging regression check `python3 -m pytest -q tests/test_packaging.py` passed: **3 passed**. The Ruff invocation above confirms it loads the new project config, but returns the baseline diagnostics listed above.

## Fixed-now status updates

| Finding | Status | Commit |
|---|---|---|
| B4.6 `index.ts` wiring | fixed-now | 9fb00f9, 6e411f7, 3900c01, c93d85c |
| B4.7 `parseFailedChecks` zero rows | fixed-now | 8fb3c57 |
| B4.7 `parseFailedChecks` multi-column status cells | fixed-now | 720b833, ea5055a |
| B4.7 explicit QA FAIL verdict with exit 0 | fixed-now | c17c7e6 |
| B4.7 quoted, blockquoted, and fenced content handling | fixed-now | 921af0d, 21febf4 |
| B4.7 real CLI plan fixture for `parsePlanResponse` | fixed-now | 86a64b1, f062c2b |
| B4.7 PlanResponse validation | fixed-now | ef683bf |
| B4.7 coupling/parallelizable defaults | fixed-now | e3b4a0c |
| B4.7 prompt-write/discovery failures | fixed-now | 87fb1ee |
| B4.7 failed `lead-report.md` link | fixed-now | 6f6da8b |
| B4.7 run duration | fixed-now | 90bce8d |
| B4.7 MAX_LEADS contract source | fixed-now | 6f2636d |
| B4.7 `recordHookFailure`/`make_ingest_status` contract fields | fixed-now | 48c411a |
| B4.7 `reconWorkers` missing complexity band | fixed-now | 5214332 |
| Dashboard spend-cap panel merge from main | fixed-now | 3b7bf5d |
| `models.ts` reconWorkers has no production caller | fixed-now | 918ffe8 |

## Phase 1 gate

At commit `21febf4`:

- `python3 -m pytest -q`: 885 passed, 1 skipped
- `bun test` (bridge): 626 pass, 0 fail
- `scripts/typecheck-bridge.sh`: 0 diagnostics
- `tests/test_layers.py` + `tests/test_dashboard_golden.py`: 11 passed

`index.ts` is 400 lines: imports, config destructuring, dependency-binding wrappers, one labelled compatibility re-export block (to be removed by B5 when `index.test.ts` is split), and the registration default export.

## Phase 2 status

| Finding | Status | Commit | Note |
|---|---|---|---|
| `appendTrimmedEventLog` (+ dead `appendDiagnosticPath`) | fixed-now | cfb6711 | No production caller; real seal-guard coverage kept |
| Archive `locate_run_file`/`locate_path` | fixed-now | 1e9ae72 | Only tests called them; removed from re-export contract set and `LocateTests` deleted |
| `should_canary` `reproducible` | fixed-now | bab9246 | |
| *ForTest aliases (`RunRegistry.setForTest`, `resetDispatchReaperForTest`) | fixed-now | 53e3c1d | Tests use real claim/release |
| Duplicate `models.ts` `reconWorkers` | fixed-now | 918ffe8 | `recon.ts` `reconWorkerCount` is the single implementation |
| Ruff E9/F/B findings (68) | fixed-now | a283fdc | Per-file ignores with reasons in `pyproject.toml`: F401 for `orchestrator/cli/__init__.py` and `orchestrator/dashboard.py` re-export shims; F822 for `scheduler.py`/`dynamic_adapter.py` `__getattr__`-resolved `__all__` names; one `# noqa: B007` in `ingest/ledger.py` |
| vulture (`--min-confidence 80`) | fixed-now | bab9246 | Clean; no `vulture_whitelist.py` needed |
| knip `--production` | fixed-already | — | 0 findings at every gate; no knip ignore needed |
| `import os as os` test hack | fixed-already | — | Not present on this branch |
| `stop_loss_multiplier` in `bridge/agents/orchestrator-lead.md` | fixed-now | 5368dca | Not wired anywhere; wording now points at `--max-retries` and the spend cap |
| `SCHEDULER_MIN_SAMPLES` 8 vs 12 | fixed-now | db7ab6a | 12, aliased to `DEFAULT_MIN_SAMPLES`; no test required 8; behaviour change in CHANGELOG. NOTE: the uncommitted recovery-plan edit to `docs/architecture-review.md` says to keep 8 — conflicts with the goal; flagged for the user |
| State-root env var names | fixed-now | 2caf00a, 4c8c208 | Canonical `CODING_AGENT_ORCHESTRATOR_HOME`, alias `HUMAIN_ORCHESTRATOR_STATE_ROOT`, precedence canonical→alias→default in Python, bridge, `install.sh` and `scripts/stamp_granularity.py` via `contract.json` |
| Bridge `any` types | fixed-now | cab688d | 11 real `any` types replaced; 0 remain in non-test bridge files |
| `controls.py` | fixed-already | — | Documented public API; nothing claims production use |

## Phase 3 status

| Finding | Status | Commit | Note |
|---|---|---|---|
| C2 provider outage fallback | deferred | — | Owned by `feat/model-failover` (no such branch on origin yet); `provider-fallback.ts` unchanged on this branch |
| C3 resume a lead once after transient failure | fixed-now | ca57c1e, 8549acf, a57198e, e5f9578, d1a052e | Local classifier `core/transient-error.ts` (replaceable by C2); bare 429/“rate limit” deliberately non-transient because provider-fallback's quota regex overlaps; never resumes timed_out/spend_cap/blocked/cancelled leads |
| C4 skip QA when no lead succeeded; absolute repo root in QA and lead prompts | fixed-now | 2d7e285 | |
| C5 verification line from real state | fixed-now | 9f10b6e | Not run / skipped (no lead) / timed out / FAIL (checks) / FAIL (unparsed) / PASS |
| C6 `--context` (repeatable) and `--with-last-reply` | fixed-now | c692f2f, 3a5010e, 5407b9a, 6713923 | 40k/source, 160k rendered aggregate, max 16 files, symlinks (incl. ancestors below the trusted anchor) and non-regular/binary files rejected, paths redacted in labels and bodies. Residual risk: a parent-directory swap race remains (Node has no openat); documented in README, accepted by security review for an operator-invoked local CLI |
| C7 missing-context goal detection with `--force` | fixed-now | 2ba0711, 438844f | Sentence-initial article “A” excluded |

## Phase 2 gate

At commit `2caf00a`:

- pytest: 889 passed, 1 skipped
- `bun test`: 628 pass, 0 fail
- typecheck: 0 diagnostics
- Ruff clean; vulture clean; knip `--production`: 0 findings
- layers + golden: 11 passed

Reviews: Phase 2 technical PASS-WITH-WARNINGS (stamp_granularity alias fixed in 4c8c208).

## Phase 3 gate

At commit `d1a052e`:

- pytest: 890 passed, 1 skipped
- `bun test`: 809 pass, 0 fail (run twice)
- typecheck: 0 diagnostics
- Ruff clean; vulture clean; knip `--production`: 0 findings
- layers + golden: 11 passed

Reviews: Phase 3 technical + security review FAIL → fixed over two rounds → security PASS-WITH-WARNINGS (residual TOCTOU accepted).

## Phase 4 status

| Finding | Status | Commit | Note |
|---|---|---|---|
| B5 index.test.ts split per module | fixed-now | 0c210f8 … b6e3170 | 825 bun tests (809 + 16 new); 5 “(index.ts wiring)” integration describes stay in index.test.ts |
| B5 global node:child_process mock → injected spawn | fixed-now | e783826, 8cea78a | `createOrchestratorCli({ spawn })`; `createOrchestratorExtension({ spawn })`; no `spyOn(childProcess)` left |
| B5 stale BorderedLoader mock; index.ts test-only re-exports | fixed-now | 42d8235 | index.ts wiring only |
| B5 tests/ingest_checkpoint package | fixed-now | a0fdc31 | 80 tests before/after |
| B5 direct tests policy_recommendations / run-diagnostics | fixed-now | f87e249, f95ff6a | |
| B5 private-function patches → fault injection | partial | 44c96f2 | `write_batch(append_stream=)` done; deferred: `archive.execute._compress_to_temp` (3 private hops below `archive_runs`), subprocess/CLI-level `_append_stream` (needs a CLI flag — design decision), ingest-pipeline `_append_stream` (cross-package API); `cli.ROOT` is a documented test seam |
| B6 SKILL.md false claims | fixed-now | 1402271 | `max_recon_cost_usd` documented as advisory/unenforced (not wired) |
| B6 orchestrator-README batch-queue write path | fixed-now | 2a53122 | |
| B6 PUBLISH.md file table | fixed-now | d905b4c | |
| B6 CHANGELOG single Unreleased | fixed-now | 4417605 | |
| B6 requires-python vs 3.9 | fixed-now | 7ace236, e9997a0 | `>=3.9` |
| B6 docs/superpowers/plans status | fixed-now | c60239a | model-failover plan marked pending on feat/model-failover |
| scripts/lint.sh (ruff + vulture + knip) in the gate | fixed-now | 9026f2a | README, bridge/README, PUBLISH |
| CI workflow (from the uncommitted recovery-plan edit in architecture-review.md) | deferred | — | Not in this goal; the recovery-plan edit is uncommitted and conflicts with the goal's SCHEDULER_MIN_SAMPLES=12 decision — left for the user |

## Phase 4 gate

At commit <filled by lead>: see final run report.

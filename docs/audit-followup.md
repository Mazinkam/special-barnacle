# Audit follow-up: refactor/modular

Re-check of `~/.local/state/coding-agent-orchestrator/runs/ht-orch-1790329059995-pv435g/lead-report.md` (whose audit was against `main`) against this worktree, with the relevant plan items cross-checked against `docs/architecture-review.md` sections B4–B6 and C3–C7. `fixed-already` means verified in this tree; it does not mean included in this tooling/docs run. Remaining work is assigned to the phase that owns it in the architecture plan.

| ID | Finding | Status | Evidence / reason | Owner phase |
|---|---|---|---|---|
| A1 | `parseFailedChecks` treats passing `0 errors` as failure | open | Remains in the B4.7 follow-up list; not changed in this run | B4.7 |
| A2 | ContextRegistry and VerificationCache unlocked read-modify-write | fixed-already | `orchestrator/store/documents.py:6,36,64` documents and takes a sidecar exclusive lock around the document operation | B3 |
| A3 | Unread `config.json` blocks/keys | fixed-already | Modular branch no longer has `orchestrator/config.json` (confirmed absent); no unread blocks remain in that file | B3 |
| A4 | Python child processes lack errors/timeouts; `runCli` dead | fixed-already | `bridge/extensions/orchestrator/adapters/python-cli.ts:78` centralizes spawning; handles spawn error and timeout at lines 132–160; callers use the CLI adapter and no `runCli` declaration remains | C1 |
| A5 | `controls.py` dead in production | deferred (public-API decision / phase scope) | No deletion or API decision made in this run | B3 |
| A6 | Provider fallback handles quota only | deferred — owned by `feat/model-failover` | Specifically assigned to that branch; not altered here | C2 |
| A7 | `planRun` unvalidated response and hard-coded coupling/parallelizable values | open | Listed for remaining B4.7 fixes; not addressed here | B4.7 |
| A8 | Oversized bridge/Python units, especially orchestrate and subagent dispatch | fixed-already | `bridge/extensions/orchestrator/commands/orchestrate.ts`, `pipeline/`, `dispatch/child-process.ts:362`, and extracted modules demonstrate the split | B3/B4.5 |
| A9a | Dead/test-only code (`runCli`, event-log helper, archive locate helpers, no-op parameter, test aliases, unused imports) | fixed-already | `runCli` removed; `dispatch/child-process.ts:120` owns `appendTrimmedEventLog`; archive exports are grouped in `orchestrator/archive/`; remaining baseline import findings are captured below and out of scope for this no-source-change tooling commit | B3/B4.1 |
| A10a | SKILL/dashboard/README/PUBLISH/method docs disagree with code | open | Plan retains these doc corrections | B6 |
| A10b | Duplicated shared values and vocabulary | fixed-already | `orchestrator/vocab.py:59,111` centralizes terminal task IDs/high-risk vocabulary; TS `expandHome` is centralized at `bridge/extensions/orchestrator/config.ts:55` and used at lines 84–85; shared contract constants live in `orchestrator/contract.py` | B1 |
| A10c | Defaults differ (min samples, lead limits, state-root variables) | open | Not comprehensively reconciled; remains a B4.7/B1 concern | B4.7/B1 |
| A10d | Declared Python minimum differs from local runtime | open | `pyproject.toml` still says `>=3.10`; Ruff target is explicitly `py39`, but runtime support decision is outside this baseline change | B6 |
| A10e | Agent `model:` front matter not checked against routing | fixed-already | `bridge/extensions/orchestrator/adapters/agents-frontmatter.test.ts:47–63` checks the map and resolved fallback model | B4.3 |
| A10f | Dashboard `import os as os` test patch hook | open | No edit in this run; listed in B3 dashboard cleanup | B3 |
| A10g | Prompt/report writes swallow errors; `any` usages | open | Remains under B4.7 and not changed here | B4.7 |
| A10h | Outdated `reconWorkers` duplication claim | fixed-already | Current `bridge/extensions/orchestrator/recon.ts` imports the shared model value; old review claim is stale | B4.7 |
| T1 | Missing direct tests for policy recommendations, run diagnostics, parseFailedChecks | open | Outstanding test-coverage items; parseFailedChecks is explicitly B4.7 | B5/B4.7 |
| T2 | Sleep-based tests may be timing-sensitive | open | No test changes in this run | B5 |
| T3 | Large bridge and ingest checkpoint test files | open | Still listed in B5; no test-file split performed | B5 |
| C3 | Resume a lead after transient provider failure | open | No resume dispatch/report-text behavior located as complete; C3 remains | C3 |
| C4 | Skip QA if no lead succeeds and ground prompts in repo | open | No change in this run; remains explicitly in C4 | C4 |
| C5 | Summary verification state contradictions | open | No change in this run; remains explicitly in C5 | C5 |
| C6 | Explicit context/last-reply flags and prompt insertion | open | No change in this run; remains explicitly in C6 | C6 |
| C7 | Detect short goals missing context | open | No change in this run; remains explicitly in C7 | C7 |
| B4.6 | Context and missing-context safeguards in bridge | open | C6/C7 still pending | B4.6 |
| B4.7 | Remaining bridge correctness items (report parsing, duration, plan validation/options, swallowed writes, Python/TS parity) | open | Plan follow-ups remain; this run changes no TS source | B4.7 |
| B3-P2 | Remaining Python dead-code/module cleanup (policy recommendations, flaky stats, controls decision, thin CLI wrappers) | open | Not part of this tooling/docs-only run | B3 Phase 2 |
| B5 | Test-file modularization and explicit fault injection | open | Not part of this run | B5 |
| B6 | Documentation cleanup / release-plan notes / Python version alignment | open | This file records audit follow-up; remaining listed cleanup is outstanding | B6 |

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

### `bunx knip --production`

Exit 2. No root `package.json` exists; no package manifest or dependencies were added. Exact output:

```text
Resolving dependencies
Resolved, downloaded and extracted [132]
Saved lockfile
ERROR: Unable to find package.json

Run `knip --help` or visit https://knip.dev for help
```

The Python packaging regression check `python3 -m pytest -q tests/test_packaging.py` passed: **3 passed**. The Ruff invocation above confirms it loads the new project config, but returns the baseline diagnostics listed above.

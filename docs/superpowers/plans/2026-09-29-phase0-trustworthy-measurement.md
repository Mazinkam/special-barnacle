# Phase 0 — Trustworthy Measurement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make time, cost, quality and iteration numbers for orchestrated runs correct and reproducible, so a frozen "current behaviour" baseline can be produced before any workflow change.

**Architecture:** Extend the existing per-run evidence join (`orchestrator/run_evidence.py::summarize_runs`) instead of adding a second truth; add a thin normalizer (`orchestrator/analytics/task_outcomes.py`) that turns those rows into one `task_outcome` per run with strata and a per-band summary. The bridge adds two small, explicit fields (`fix_rounds`, `usage_scope`). Analysis scripts switch to the shared classifiers (`orchestrator.records.classify`, `orchestrator.outcomes.bad_signal`). One narrowly scoped, reversible migration relabels `$0`-without-usage rows.

**Tech Stack:** Python 3.9+ stdlib (`unittest`/pytest), TypeScript on Bun (`bun:test`), JSONL streams under the orchestrator state root.

**Spec:** `docs/superpowers/specs/2026-09-29-tiered-workflows-and-eval-design.md` (Section 1). Sections 2–4 get their own plans after this one ships, because they consume its data.

## Global Constraints

- Python must stay compatible with `requires-python = ">=3.9"`: `from __future__ import annotations`, no `match`, no `X | Y` at runtime outside annotations.
- Lint is `ruff` with `select = ["E9", "F", "B"]`; run `bash scripts/lint.sh` (exit 2 = tools missing, report as skipped).
- Python tests: `python3 -m pytest -q`. Bridge tests: `cd bridge/extensions/orchestrator && bun test`. Bridge typecheck: `bash scripts/typecheck-bridge.sh`.
- No new dependencies.
- The working tree has unrelated uncommitted edits (`index.ts`, `core/prompts.ts`, `dispatch/*`, `SKILL.md`, `README.md`, …). Never `git add -A`/`git commit -a`; stage only the files each task lists.
- Never write to the live state root (`~/.local/state/coding-agent-orchestrator`) during implementation or tests. Tests use temp dirs; migration writes to live state only by a human after dry-run review.
- Missing evidence is `unknown`/`None`, never `0`, `fail` or `pass`.
- Decision/route events (`records.NON_COST_EVENTS`, e.g. `route_executed`, `adaptive_route_decision`) are never counted as calls, work or outcomes.
- Reuse: `records.classify`/`records.EVENT`, `economics.cost_class`/`has_reported_tokens`/`quantile`, `outcomes.bad_signal`, `runtime.writer_lock`, `state.rebuild`, `core.env.default_state_root`.

## Review Focus

1. An outcome whose regression signal is only inside the JSON `note` (`{"regression": true}`) must mark the run as a delayed bad outcome in run evidence, exactly as the dashboard/history already do — Task 1.
2. A run with `run_started` but no terminal record must keep `elapsed_ms = None`; elapsed must never be reconstructed from arbitrary metric timestamps — Task 2.
3. A failover dispatch (two `dispatch_finished` attempts, first `superseded_by_fallback`) is a provider retry, not a quality fix round — Task 3.
4. A malformed line in `metrics.jsonl` must survive the migration byte-for-byte, and running the migration twice must be a no-op — Task 9.
5. A run whose only verdict evidence is missing must appear as `verification = unknown` and be excluded from the pass-rate denominator but counted in the "all assigned" denominator — Tasks 5 and 7.

---

### Task 1: One definition of a delayed bad outcome in run evidence

`run_evidence.summarize_runs` checks `BAD_OUTCOME_KEYS` on top-level fields only; `outcomes.bad_signal` (used by history, dashboard, model comparison) also reads the JSON in `note`. Make run evidence use `bad_signal`.

**Files:**
- Modify: `orchestrator/run_evidence.py` (imports near line 60; the outcomes loop at ~line 392: `if any(o.get(k) for k in BAD_OUTCOME_KEYS): delayed_bad[rid] = True`)
- Test: `tests/test_run_evidence.py`

**Interfaces:**
- Consumes: `orchestrator.outcomes.bad_signal(row: dict) -> bool`
- Produces: `summarize_runs(...)[i]['delayed_bad_outcome']` now agrees with `bad_signal`. `BAD_OUTCOME_KEYS` stays exported (other code may import it).

- [ ] **Step 1: Write the failing tests** — append to `tests/test_run_evidence.py`:

```python
class DelayedBadOutcomeSemanticsTests(unittest.TestCase):
    def test_note_json_regression_marks_run_bad(self):
        outcomes=[{'run_id':'rb1','task_id':'rb1-t1','outcome':'verified','note':'{"regression": true}'}]
        r=by_run(summarize_runs([call('rb1','rb1-t1',cost_usd=.01,cost_source='reported')],[],outcomes))['rb1']
        self.assertTrue(r['delayed_bad_outcome'])

    def test_explicit_top_level_false_wins_over_note(self):
        outcomes=[{'run_id':'rb2','task_id':'rb2-t1','outcome':'verified','regression':False,'note':'{"regression": true}'}]
        r=by_run(summarize_runs([call('rb2','rb2-t1',cost_usd=.01,cost_source='reported')],[],outcomes))['rb2']
        self.assertFalse(r['delayed_bad_outcome'])
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest -q tests/test_run_evidence.py -k DelayedBadOutcomeSemantics`
Expected: `test_note_json_regression_marks_run_bad` FAILS (`False is not true`).

- [ ] **Step 3: Implement** — in `orchestrator/run_evidence.py` add the import next to the other package imports:

```python
from .outcomes import bad_signal
```

and replace the outcomes-loop line:

```python
        if any(o.get(k) for k in BAD_OUTCOME_KEYS): delayed_bad[rid] = True
```

with:

```python
        # One definition of "bad" across run evidence, history and the dashboard: typed top-level
        # fields win, JSON-in-note is the fallback (`outcomes.bad_signal`).
        if bad_signal(o): delayed_bad[rid] = True
```

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest -q tests/test_run_evidence.py tests/test_final_integration.py tests/test_dashboard_metrics.py`
Expected: all PASS. If `ruff` reports `BAD_OUTCOME_KEYS` unused, keep it and add it to the module's `__all__` if one exists; otherwise leave it (it is a module-level constant, not an unused import).

- [ ] **Step 5: Commit**

```bash
git add orchestrator/run_evidence.py tests/test_run_evidence.py
git commit -m "fix(evidence): use shared bad_signal for delayed outcomes in run evidence"
```

---

### Task 2: Lifecycle-timestamp elapsed fallback

Older runs have `run_started.started_at` and a terminal event `ts` but no `elapsed_ms`/`finished_at`. Reconstruct elapsed only from that credible pair, labelled `lifecycle_timestamps`.

**Files:**
- Modify: `orchestrator/run_evidence.py` (events loop ~line 370–380; the line `elapsed_ms, elapsed_source = _elapsed(term)` ~line 500)
- Test: `tests/test_run_evidence.py`

**Interfaces:**
- Consumes: existing `_parse_ts` (alias of `vocab.parse_iso_ts`), `started_events`, `TERMINAL_EVENTS`.
- Produces: `elapsed_source` may now be `'lifecycle_timestamps'` in addition to `'monotonic' | 'reported' | 'timestamps' | 'unknown'`.

- [ ] **Step 1: Write the failing tests**

```python
class LifecycleElapsedTests(unittest.TestCase):
    def test_run_started_plus_terminal_event_ts(self):
        events=[{'event':'run_started','run_id':'le1','started_at':'2026-09-20T10:00:00+00:00','ts':'2026-09-20T10:00:00+00:00'},
                {'event':'run_failed','run_id':'le1','error':'x','ts':'2026-09-20T10:02:00+00:00'}]
        r=by_run(summarize_runs([],events,[]))['le1']
        self.assertEqual(r['elapsed_ms'],120000)
        self.assertEqual(r['elapsed_source'],'lifecycle_timestamps')

    def test_no_terminal_keeps_elapsed_unknown(self):
        events=[{'event':'run_started','run_id':'le2','started_at':'2026-09-20T10:00:00+00:00','ts':'2026-09-20T10:00:00+00:00'}]
        metrics=[call('le2','le2-t1',cost_usd=.01,cost_source='reported',ts='2026-09-20T11:00:00+00:00')]
        r=by_run(summarize_runs(metrics,events,[]))['le2']
        self.assertIsNone(r['elapsed_ms'])
        self.assertEqual(r['elapsed_source'],'unknown')

    def test_reported_elapsed_is_not_overridden(self):
        events=[{'event':'run_started','run_id':'le3','started_at':'2026-09-20T10:00:00+00:00'},
                {'event':'run_completed','run_id':'le3','elapsed_ms':5000,'elapsed_source':'monotonic','ts':'2026-09-20T10:09:00+00:00'}]
        r=by_run(summarize_runs([],events,[]))['le3']
        self.assertEqual(r['elapsed_ms'],5000)
        self.assertEqual(r['elapsed_source'],'monotonic')
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest -q tests/test_run_evidence.py -k LifecycleElapsed`
Expected: `test_run_started_plus_terminal_event_ts` FAILS (`None != 120000`).

- [ ] **Step 3: Implement** — next to `started_events: dict[str, dict] = {}` add:

```python
    terminal_event_ts: dict[str, str] = {}
```

inside the events loop, in the `elif kind in TERMINAL_EVENTS:` branch, add as the first statement:

```python
            if e.get('ts'): terminal_event_ts.setdefault(rid, str(e['ts']))
```

and directly after `elapsed_ms, elapsed_source = _elapsed(term)` add:

```python
        if elapsed_ms is None:
            # Credible lifecycle pair only: the owning process's own start stamp and the ts of the
            # terminal event it wrote. Never first/last metric timestamps (those are not lifecycle).
            start = _parse_ts(started_events.get(rid, {}).get('started_at'))
            finish = _parse_ts(terminal_event_ts.get(rid))
            if start and finish and finish >= start:
                elapsed_ms, elapsed_source = int((finish - start).total_seconds() * 1000), 'lifecycle_timestamps'
```

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest -q tests/test_run_evidence.py tests/test_dashboard_refresh.py tests/test_final_integration.py`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/run_evidence.py tests/test_run_evidence.py
git commit -m "feat(evidence): reconstruct legacy elapsed from run_started + terminal event"
```

---

### Task 3: Separate fix rounds from provider retries in run evidence

Today `retries` mixes retried dispatches and the summary's QA retry count. Add explicit `fix_rounds` (quality repair rounds from the run summary) and `provider_retries` (superseded failover attempts). Keep `retries` unchanged for existing consumers.

**Files:**
- Modify: `orchestrator/run_evidence.py` (events loop; result dict ~line 525)
- Test: `tests/test_run_evidence.py`

**Interfaces:**
- Consumes: run-complete outcome `note` JSON (`fix_rounds`, falling back to legacy `retries`); `dispatch_finished` events with `superseded_by_fallback: true`.
- Produces: new keys on every `summarize_runs` row: `fix_rounds: int | None`, `provider_retries: int`.

- [ ] **Step 1: Write the failing tests**

```python
class IterationCounterTests(unittest.TestCase):
    def test_failover_is_provider_retry_not_fix_round(self):
        events=[{'event':'dispatch_finished','run_id':'it1','task_id':'t','attempt':1,'superseded_by_fallback':True},
                {'event':'dispatch_finished','run_id':'it1','task_id':'t','attempt':2}]
        outcomes=[{'run_id':'it1','task_id':'run-complete','outcome':'verified','note':'{"fix_rounds": 0, "retries": 0}'}]
        r=by_run(summarize_runs([],events,outcomes))['it1']
        self.assertEqual(r['provider_retries'],1)
        self.assertEqual(r['fix_rounds'],0)

    def test_legacy_retries_note_becomes_fix_rounds(self):
        outcomes=[{'run_id':'it2','task_id':'run-complete','outcome':'fail','note':'{"retries": 2}'}]
        r=by_run(summarize_runs([],[],outcomes))['it2']
        self.assertEqual(r['fix_rounds'],2)

    def test_unknown_fix_rounds_is_none(self):
        r=by_run(summarize_runs([call('it3','t',cost_usd=.01,cost_source='reported')],[],[]))['it3']
        self.assertIsNone(r['fix_rounds'])
        self.assertEqual(r['provider_retries'],0)
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest -q tests/test_run_evidence.py -k IterationCounter`
Expected: FAIL with `KeyError: 'provider_retries'`.

- [ ] **Step 3: Implement** — next to `rework_events` add:

```python
    provider_retries: dict[str, int] = defaultdict(int)
```

in the events loop add a branch before the `rework` branch:

```python
        elif kind == 'dispatch_finished' and e.get('superseded_by_fallback') is True: provider_retries[rid] += 1
```

before `result.append({` add:

```python
        fix_rounds = _int_or_none(note.get('fix_rounds'))
        if fix_rounds is None: fix_rounds = _int_or_none(note.get('retries'))
```

and add to the result dict next to `'retries': retries,`:

```python
            'fix_rounds': fix_rounds, 'provider_retries': provider_retries[rid],
```

Note: the existing `elif kind == 'dispatch_started' and e.get('retry_of')` branch must stay before the new branch; `dispatch_finished` is a different event, so order only matters relative to the catch-all branches.

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest -q tests/test_run_evidence.py tests/test_dashboard_golden.py`
Expected: PASS. If a dashboard golden test snapshots the full run row, regenerate only after confirming the only diff is the two new keys.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/run_evidence.py tests/test_run_evidence.py
git commit -m "feat(evidence): split fix_rounds from provider_retries per run"
```

---

### Task 4: Bridge emits `fix_rounds` and `usage_scope`

`retries` in the run summary is the QA fix-round counter; name it explicitly. Mark failed dispatch usage as a partial lower bound so cost reports can say so.

**Files:**
- Modify: `bridge/extensions/orchestrator/pipeline/run-orchestration.ts` (the `deps.completeRun(runId, { … retries, … })` call ~line 1030)
- Modify: `bridge/extensions/orchestrator/core/records.ts` (`dispatchRecordsFor`, the `model_call` object ~line 173)
- Test: `bridge/extensions/orchestrator/core/records.test.ts`, `bridge/extensions/orchestrator/pipeline/run-orchestration.test.ts`

**Interfaces:**
- Produces: run-complete `note` JSON gains `fix_rounds: number` (same value as `retries`). `model_call` rows gain `usage_scope: "final" | "partial"` (`"partial"` when `exitCode !== 0`).

- [ ] **Step 1: Write the failing tests** — in `core/records.test.ts`, inside `describe("core/records.ts dispatchRecordsFor", …)`:

```ts
	test("marks usage from a failed dispatch as a partial lower bound", () => {
		const [call] = dispatchRecordsFor(opts, result({ exitCode: 1, costReported: false }));
		expect(call.usage_scope).toBe("partial");
		expect(call.cost_usd).toBeUndefined();
	});

	test("marks usage from a clean dispatch as final", () => {
		const [call] = dispatchRecordsFor(opts, result());
		expect(call.usage_scope).toBe("final");
	});
```

In `pipeline/run-orchestration.test.ts`, the resume test at ~line 470 (`"a lead that fails once with a transient (503) error then succeeds on resume…"`) already captures `completedSummary` via `completeRun: async (_runId, summary) => { completedSummary = summary; … }`. Add at the end of that test:

```ts
		expect(completedSummary?.fix_rounds).toBe(completedSummary?.retries);
		expect(typeof completedSummary?.fix_rounds).toBe("number");
```

- [ ] **Step 2: Run to verify failure**

Run: `cd bridge/extensions/orchestrator && bun test core/records.test.ts pipeline/run-orchestration.test.ts`
Expected: FAIL (`usage_scope` undefined; `fix_rounds` undefined).

- [ ] **Step 3: Implement** — in `core/records.ts`, in the `model_call` object right after `duration_ms: result?.durationMs ?? 0,` add:

```ts
		// A non-zero exit means the child may have died before its final usage report: tokens
		// seen are a lower bound, not the call's full usage (spec §1.2).
		usage_scope: result?.exitCode === 0 ? "final" : "partial",
```

In `pipeline/run-orchestration.ts`, in the `deps.completeRun(runId, { … })` object, directly after `retries,` add:

```ts
		// Quality repair rounds (QA/escalation loop iterations). `retries` is kept for existing
		// readers; `fix_rounds` is the explicit name the evaluation reads (spec §1.3).
		fix_rounds: retries,
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd bridge/extensions/orchestrator && bun test && cd - && bash scripts/typecheck-bridge.sh`
Expected: all tests PASS; typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add bridge/extensions/orchestrator/core/records.ts bridge/extensions/orchestrator/core/records.test.ts bridge/extensions/orchestrator/pipeline/run-orchestration.ts bridge/extensions/orchestrator/pipeline/run-orchestration.test.ts
git commit -m "feat(bridge): emit fix_rounds and usage_scope for evaluation"
```

---

### Task 5: `task_outcome` normalizer and per-band summary

One normalized record per run, built on `summarize_runs`, with execution status separated from verification, strata from call rows, and a band summary with explicit denominators and coverage.

**Files:**
- Create: `orchestrator/analytics/task_outcomes.py`
- Test: `tests/test_task_outcomes.py`

**Interfaces:**
- Consumes: `summarize_runs(metrics, events, outcomes, *, liveness_check=...)` rows incl. Task 2/3 keys; `records.classify`, `records.CALL`; `economics.quantile`; `method.load_method()`.
- Produces:
  - `task_outcomes(metrics: list[dict], events: list[dict], outcomes: list[dict], **summarize_kwargs) -> list[dict]` with keys `run_id, execution_status, verification, blocked, task_class, complexity, complexity_band, risk, started_at, finished_at, elapsed_ms, elapsed_source, cost_known_usd, cost_complete, usage_partial_calls, fix_rounds, provider_retries, delayed_bad_outcome`.
  - `summarize_task_outcomes(rows: list[dict], key: str = 'complexity_band') -> dict[str, dict]` with per-group keys `n, pass, fail, unknown, blocked, pass_rate_known, verified_rate_all, elapsed_p50_ms, elapsed_p90_ms, elapsed_coverage, cost_known_usd, cost_complete_coverage, cost_per_verified_usd, fix_rounds_mean, provider_retries_mean, delayed_bad`.

- [ ] **Step 1: Write the failing tests** — `tests/test_task_outcomes.py`:

```python
import unittest
from orchestrator.analytics.task_outcomes import task_outcomes, summarize_task_outcomes


def call(run_id, **kw):
    row = {'event': 'model_call', 'run_id': run_id, 'task_id': f'{run_id}-t', 'role': 'worker',
           'capability_class': 'implementation_fast', 'model': 'anthropic/claude-sonnet-4-5',
           'agent_runtime': 'humain-terminal', 'task_class': 'implementation', 'complexity': 3, 'risk': 'low'}
    row.update(kw); return row


def complete(run_id, outcome='verified', **note):
    import json
    return {'run_id': run_id, 'task_id': 'run-complete', 'outcome': outcome, 'verification_scope': 'run',
            'note': json.dumps(note), 'elapsed_ms': 60000, 'elapsed_source': 'monotonic'}


class TaskOutcomeTests(unittest.TestCase):
    def test_route_executed_rows_do_not_create_calls_or_outcomes(self):
        metrics = [call('a', cost_usd=.1, cost_source='reported', input_tokens=10, output_tokens=5),
                   {'event': 'route_executed', 'run_id': 'a', 'task_id': 'a-t', 'complexity': 9, 'risk': 'critical'}]
        [row] = task_outcomes(metrics, [], [complete('a', verification_passed=True)])
        self.assertEqual(row['complexity'], 3)          # decision row ignored for strata
        self.assertEqual(row['risk'], 'low')
        self.assertEqual(row['complexity_band'], 'small')

    def test_status_and_verification_are_separate(self):
        [row] = task_outcomes([call('b')], [], [complete('b', outcome='fail', verification_passed=False)])
        self.assertEqual(row['execution_status'], 'completed')
        self.assertEqual(row['verification'], 'fail')

    def test_missing_verdict_is_unknown(self):
        [row] = task_outcomes([call('c', cost_usd=.1, cost_source='reported', input_tokens=1)], [], [])
        self.assertEqual(row['verification'], 'unknown')
        self.assertEqual(row['execution_status'], 'unknown')

    def test_blocked_run(self):
        [row] = task_outcomes([call('d')], [], [complete('d', outcome='blocked', blocked=True)])
        self.assertTrue(row['blocked'])
        self.assertEqual(row['verification'], 'unknown')

    def test_partial_usage_makes_cost_incomplete(self):
        metrics = [call('e', cost_usd=.2, cost_source='reported', input_tokens=10, output_tokens=5),
                   call('e', usage_scope='partial', input_tokens=50, output_tokens=0, cost_usd=.01, cost_source='estimated-from-reported-tokens')]
        [row] = task_outcomes(metrics, [], [complete('e', verification_passed=True)])
        self.assertFalse(row['cost_complete'])
        self.assertEqual(row['usage_partial_calls'], 1)


class SummaryTests(unittest.TestCase):
    def test_denominators_and_cost_per_verified(self):
        rows = [
            {'complexity_band': 'small', 'verification': 'pass', 'blocked': False, 'elapsed_ms': 1000, 'cost_known_usd': 1.0, 'cost_complete': True, 'fix_rounds': 0, 'provider_retries': 0, 'delayed_bad_outcome': None},
            {'complexity_band': 'small', 'verification': 'fail', 'blocked': False, 'elapsed_ms': 3000, 'cost_known_usd': 1.0, 'cost_complete': True, 'fix_rounds': 1, 'provider_retries': 1, 'delayed_bad_outcome': None},
            {'complexity_band': 'small', 'verification': 'unknown', 'blocked': False, 'elapsed_ms': None, 'cost_known_usd': None, 'cost_complete': False, 'fix_rounds': None, 'provider_retries': 0, 'delayed_bad_outcome': True},
        ]
        s = summarize_task_outcomes(rows)['small']
        self.assertEqual((s['n'], s['pass'], s['fail'], s['unknown']), (3, 1, 1, 1))
        self.assertAlmostEqual(s['pass_rate_known'], .5)
        self.assertAlmostEqual(s['verified_rate_all'], 1 / 3)
        self.assertAlmostEqual(s['elapsed_coverage'], 2 / 3)
        self.assertIsNone(s['cost_per_verified_usd'])   # one run's cost is incomplete
        self.assertAlmostEqual(s['fix_rounds_mean'], .5)
        self.assertEqual(s['delayed_bad'], 1)

    def test_zero_passes_has_no_finite_cost_per_success(self):
        rows = [{'complexity_band': 'large', 'verification': 'fail', 'blocked': False, 'elapsed_ms': 10, 'cost_known_usd': 2.0, 'cost_complete': True, 'fix_rounds': 0, 'provider_retries': 0, 'delayed_bad_outcome': None}]
        self.assertIsNone(summarize_task_outcomes(rows)['large']['cost_per_verified_usd'])
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest -q tests/test_task_outcomes.py`
Expected: FAIL with `ModuleNotFoundError: orchestrator.analytics.task_outcomes`.

- [ ] **Step 3: Implement** — `orchestrator/analytics/task_outcomes.py`:

```python
"""One normalized `task_outcome` per run, built on `run_evidence.summarize_runs` (spec §1.1).

This is a view, not a second ledger: every value comes from the existing per-run evidence join
plus the run's own call rows for strata. Missing evidence stays `unknown`/`None`.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any

from orchestrator import records
from orchestrator.economics import is_session_ingest, quantile
from orchestrator.method import load_method
from orchestrator.run_evidence import summarize_runs

_RISK_ORDER = {'low': 0, 'medium': 1, 'high': 2, 'critical': 3}
_EXECUTION = {'completed', 'failed', 'cancelled', 'interrupted'}
_VERIFICATION = {'passed': 'pass', 'failed': 'fail'}


def _band(complexity: float | None) -> str | None:
    if complexity is None:
        return None
    for b in load_method()['rules']['lead_sizing']['by_complexity']:
        if b['min'] <= complexity <= b['max']:
            return b['size']
    return None


def _strata(rows: list[dict]) -> dict[str, Any]:
    calls = [r for r in rows if records.classify(r) == records.CALL]
    cx = [float(r['complexity']) for r in calls if isinstance(r.get('complexity'), (int, float))]
    risks = [r['risk'] for r in calls if r.get('risk') in _RISK_ORDER]
    classes = Counter(r['task_class'] for r in calls if r.get('task_class'))
    complexity = max(cx) if cx else None
    return {
        'task_class': classes.most_common(1)[0][0] if classes else None,
        'complexity': complexity,
        'complexity_band': _band(complexity),
        'risk': max(risks, key=_RISK_ORDER.__getitem__) if risks else None,
        'usage_partial_calls': sum(1 for r in calls if r.get('usage_scope') == 'partial'),
    }


def task_outcomes(metrics: list[dict], events: list[dict], outcomes: list[dict], **summarize_kwargs) -> list[dict]:
    by_run: dict[str, list[dict]] = defaultdict(list)
    for r in metrics:
        if r.get('run_id') is not None and not is_session_ingest(r):
            by_run[str(r['run_id'])].append(r)
    blocked = {str(o['run_id']) for o in outcomes
               if o.get('run_id') is not None and o.get('task_id') == 'run-complete' and o.get('outcome') == 'blocked'}
    result = []
    for ev in summarize_runs(metrics, events, outcomes, **summarize_kwargs):
        rid = ev['run_id']
        strata = _strata(by_run.get(rid, []))
        is_blocked = rid in blocked
        result.append({
            'run_id': rid,
            'execution_status': ev['status'] if ev['status'] in _EXECUTION else 'unknown',
            'verification': 'unknown' if is_blocked else _VERIFICATION.get(ev['verification'], 'unknown'),
            'blocked': is_blocked,
            **{k: strata[k] for k in ('task_class', 'complexity', 'complexity_band', 'risk')},
            'started_at': ev['started_at'], 'finished_at': ev['finished_at'],
            'elapsed_ms': ev['elapsed_ms'], 'elapsed_source': ev['elapsed_source'],
            'cost_known_usd': ev['cost_known_usd'],
            'cost_complete': bool(ev['cost_complete']) and strata['usage_partial_calls'] == 0,
            'usage_partial_calls': strata['usage_partial_calls'],
            'fix_rounds': ev.get('fix_rounds'),
            'provider_retries': ev.get('provider_retries', 0),
            'delayed_bad_outcome': ev['delayed_bad_outcome'],
        })
    return result


def _mean(xs: list[float]) -> float | None:
    return sum(xs) / len(xs) if xs else None


def _q(xs: list[float], p: float) -> float | None:
    v = quantile(xs, p)
    return None if records.is_no_data(v) else v


def summarize_task_outcomes(rows: list[dict], key: str = 'complexity_band') -> dict[str, dict]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        groups[str(r.get(key) or 'unknown')].append(r)
    out: dict[str, dict] = {}
    for name, g in groups.items():
        n = len(g)
        passes = sum(1 for r in g if r['verification'] == 'pass')
        fails = sum(1 for r in g if r['verification'] == 'fail')
        elapsed = [float(r['elapsed_ms']) for r in g if r.get('elapsed_ms') is not None]
        all_complete = all(r.get('cost_complete') for r in g)
        known_cost = sum(float(r['cost_known_usd']) for r in g if r.get('cost_known_usd') is not None)
        fixes = [float(r['fix_rounds']) for r in g if r.get('fix_rounds') is not None]
        out[name] = {
            'n': n, 'pass': passes, 'fail': fails, 'unknown': n - passes - fails,
            'blocked': sum(1 for r in g if r.get('blocked')),
            'pass_rate_known': passes / (passes + fails) if passes + fails else None,
            'verified_rate_all': passes / n if n else None,
            'elapsed_p50_ms': _q(elapsed, .5), 'elapsed_p90_ms': _q(elapsed, .9),
            'elapsed_coverage': len(elapsed) / n if n else None,
            'cost_known_usd': known_cost,
            'cost_complete_coverage': sum(1 for r in g if r.get('cost_complete')) / n if n else None,
            # Finite only when every run's cost is complete and at least one run verified.
            'cost_per_verified_usd': known_cost / passes if passes and all_complete else None,
            'fix_rounds_mean': _mean(fixes),
            'provider_retries_mean': _mean([float(r.get('provider_retries') or 0) for r in g]),
            'delayed_bad': sum(1 for r in g if r.get('delayed_bad_outcome')),
        }
    return out
```

If `records.CALL`/`records.is_no_data` are not exported under these names, check `orchestrator/records/__init__.py` (lines 34 and 410–413 define `CALL`, `EVENT`, `NO_DATA`, `is_no_data`) and use the exact names defined there.

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest -q tests/test_task_outcomes.py tests/test_layers.py tests/test_import_side_effects.py`
Expected: PASS. `test_layers.py` enforces package layering; if it rejects `analytics` importing `run_evidence`, move the module to the layer that test allows and update the import paths in this task and Tasks 7 and 10.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/analytics/task_outcomes.py tests/test_task_outcomes.py
git commit -m "feat(analytics): normalized task_outcome view and per-band summary"
```

---

### Task 6: `defect-link` CLI subcommand

Record a delayed defect candidate against an original run. Only `confirmed` links count as bad outcomes, via the existing `regression` key read by `bad_signal`.

**Files:**
- Modify: `orchestrator/cli/records_cmds.py` (`register`, new handler, `HANDLERS`)
- Test: `tests/test_cli_argv_table.py` (add a `CASES` row), `tests/test_defect_link.py`

**Interfaces:**
- Consumes: `cli._single('outcome', payload_json, root=root)`.
- Produces: outcome rows `{run_id, task_id: 'defect-link', kind: 'defect_link', defect_type, severity, evidence, attribution, confirmed, regression: confirmed}`.
  Command: `python3 -m orchestrator.cli defect-link RUN_ID --type {revert,reopened,bug_traced,hotfix} --severity {low,medium,high,critical} --evidence TEXT [--attribution {exact_lineage,human_confirmed,file_overlap}] [--confirmed]`.

- [ ] **Step 1: Write the failing tests** — add to `CASES` in `tests/test_cli_argv_table.py`:

```python
    (['defect-link', 'R1', '--type', 'revert', '--severity', 'high', '--evidence', 'abc123 reverts'],
     {'cmd': 'defect-link', 'run_id': 'R1', 'type': 'revert', 'severity': 'high', 'evidence': 'abc123 reverts',
      'attribution': 'file_overlap', 'confirmed': False}),
```

Create `tests/test_defect_link.py`:

```python
import json
import sys
from unittest import mock

import pytest

from orchestrator import cli
from orchestrator.outcomes import bad_signal


def _run(tmp_path, argv):
    # `cli.main()` takes no argv parameter; it parses `sys.argv` (orchestrator/cli/__init__.py:195).
    with mock.patch.object(cli, 'ROOT', tmp_path), mock.patch.object(sys, 'argv', ['orchestrator', *argv]):
        with pytest.raises(SystemExit) as exc:
            cli.main()
    return exc.value.code


def _rows(tmp_path):
    return [json.loads(l) for l in (tmp_path / 'outcomes.jsonl').read_text().splitlines() if l.strip()]


def test_unconfirmed_link_is_candidate_not_bad(tmp_path):
    assert _run(tmp_path, ['defect-link', 'R1', '--type', 'revert', '--severity', 'high', '--evidence', 'x']) == 0
    [row] = _rows(tmp_path)
    assert row['kind'] == 'defect_link' and row['task_id'] == 'defect-link' and row['confirmed'] is False
    assert bad_signal(row) is False


def test_confirmed_link_counts_as_regression(tmp_path):
    assert _run(tmp_path, ['defect-link', 'R2', '--type', 'bug_traced', '--severity', 'medium',
                           '--evidence', 'issue 42', '--attribution', 'human_confirmed', '--confirmed']) == 0
    [row] = _rows(tmp_path)
    assert row['regression'] is True and bad_signal(row) is True
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest -q tests/test_cli_argv_table.py tests/test_defect_link.py`
Expected: FAIL (`invalid choice: 'defect-link'`).

- [ ] **Step 3: Implement** — in `register()` after the `outcome` parser:

```python
    d = sp.add_parser('defect-link', help='record a delayed-defect candidate against an original run (only --confirmed counts as bad)')
    d.add_argument('run_id', help='run_id of the original orchestrated run')
    d.add_argument('--type', required=True, choices=['revert', 'reopened', 'bug_traced', 'hotfix'])
    d.add_argument('--severity', required=True, choices=['low', 'medium', 'high', 'critical'])
    d.add_argument('--evidence', required=True, help='commit sha, issue link or short description')
    d.add_argument('--attribution', default='file_overlap', choices=['exact_lineage', 'human_confirmed', 'file_overlap'])
    d.add_argument('--confirmed', action='store_true', help='causality confirmed; counts against the run')
```

handler:

```python
def handle_defect_link(args, root, C) -> None:
    from orchestrator import cli
    payload = {
        'run_id': args.run_id, 'task_id': 'defect-link', 'kind': 'defect_link',
        'defect_type': args.type, 'severity': args.severity, 'evidence': args.evidence,
        'attribution': args.attribution, 'confirmed': bool(args.confirmed),
        # `regression` is the key `outcomes.bad_signal` already reads; a candidate states False
        # explicitly so a note payload can never turn it bad.
        'regression': bool(args.confirmed),
    }
    raise SystemExit(cli._single('outcome', json.dumps(payload), root=root))
```

and add `'defect-link': handle_defect_link,` to `HANDLERS`.

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest -q tests/test_cli_argv_table.py tests/test_defect_link.py tests/test_cli_args.py tests/test_cli_reexports.py`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/cli/records_cmds.py tests/test_cli_argv_table.py tests/test_defect_link.py
git commit -m "feat(cli): defect-link records confirmed/candidate delayed defects"
```

---

### Task 7: Correct `skill_vs_baseline.py` counting and add task-outcome report

**Files:**
- Modify: `scripts/skill_vs_baseline.py` (`STATE`/`METRICS` constants ~line 28; `PASS_VALUES` line 42; `is_decision_record` line 76; `aggregate` lines 96–150; `per_breakdown` lines 153–190; `main`)
- Test: `tests/test_skill_vs_baseline.py`

**Interfaces:**
- Consumes: `records.classify`, `records.EVENT`, `core.env.default_state_root`, `iter_jsonl`, Task 5 `task_outcomes`/`summarize_task_outcomes`.
- Produces: `aggregate()` keys gain `unknown_result_count`; `fail_count` counts explicit failures only; `success_rate = pass/(pass+fail)`. New CLI flag `--state-dir PATH` (default `default_state_root()`). New printed section "Task outcomes by complexity band".

- [ ] **Step 1: Write the failing tests** — add to the test class in `tests/test_skill_vs_baseline.py`:

```python
    def test_route_events_are_not_work_and_missing_result_is_unknown(self):
        rows = [
            {'event': 'model_call', 'result': 'pass', 'cost_usd': .1, 'input_tokens': 10, 'output_tokens': 5, 'model': 'claude-sonnet-5-5'},
            {'event': 'model_call', 'result': 'fail', 'cost_usd': .1, 'input_tokens': 10, 'output_tokens': 5, 'model': 'claude-sonnet-5-5'},
            {'event': 'model_call', 'cost_usd': .1, 'input_tokens': 10, 'output_tokens': 5, 'model': 'claude-sonnet-5-5'},
            {'event': 'route_executed', 'executed_model': 'x'},
            {'event': 'adaptive_route_decision'},
        ]
        agg = skill_vs_baseline.aggregate(rows, {'enabled': False, 'models': {}})
        self.assertEqual(agg['work_records'], 3)
        self.assertEqual(agg['decision_records'], 2)
        self.assertEqual((agg['pass_count'], agg['fail_count'], agg['unknown_result_count']), (1, 1, 1))
        self.assertAlmostEqual(agg['success_rate'], .5)
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest -q tests/test_skill_vs_baseline.py`
Expected: FAIL (`work_records` 4 ≠ 3, or `KeyError: 'unknown_result_count'`).

- [ ] **Step 3: Implement**

Imports (after the existing `orchestrator.*` imports):

```python
from orchestrator import records  # noqa: E402
from orchestrator.core.env import default_state_root  # noqa: E402
```

Replace the constants `STATE = Path('~/.local/state/…').expanduser()` / `METRICS = STATE / 'metrics.jsonl'` with:

```python
STATE = default_state_root()
METRICS = STATE / 'metrics.jsonl'
```

After `PASS_VALUES` add:

```python
FAIL_VALUES = {'fail', 'failed', 'error', 'timeout'}
```

Replace `is_decision_record`:

```python
def is_decision_record(r: dict[str, Any]) -> bool:
    """Decision/route events (`route_executed`, `adaptive_route_decision`, …) are not work."""
    return records.classify(r) == records.EVENT
```

In `aggregate`, replace the `pass_count` line and the `fail_count`/`success_rate` entries:

```python
    pass_count = sum(1 for r in work if str(r.get('result', '')).lower() in PASS_VALUES)
    fail_count = sum(1 for r in work if str(r.get('result', '')).lower() in FAIL_VALUES)
    known = pass_count + fail_count
```

```python
        'fail_count': fail_count,
        'unknown_result_count': len(work) - known,
        'success_rate': round(pass_count / known, 4) if known else None,
```

In `per_breakdown`, replace `'success_rate': round(pass_count / len(rows), 4) if rows else None,` with:

```python
            'success_rate': (round(pass_count / known_rows, 4) if known_rows else None),
```

computing before it:

```python
        known_rows = sum(1 for r in rows if str(r.get('result', '')).lower() in PASS_VALUES | FAIL_VALUES)
```

In `main`, before `if not METRICS.exists()`, add argument parsing and root resolution:

```python
    import argparse
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--state-dir', type=Path, default=STATE, help='state root to read (default: resolved state root)')
    args = parser.parse_args()
    metrics_path = args.state_dir / 'metrics.jsonl'
```

and use `metrics_path` instead of `METRICS` inside `main`. Change the pass/fail print to:

```python
    print(f'  pass / fail / unknown:       {agg_o["pass_count"]} / {agg_o["fail_count"]} / {agg_o["unknown_result_count"]}')
```

At the end of `main`, before `return 0`, add the task-outcome section:

```python
    from orchestrator.analytics.task_outcomes import task_outcomes, summarize_task_outcomes
    from orchestrator.runtime import iter_jsonl
    events = list(iter_jsonl(args.state_dir / 'events.jsonl'))
    outcomes = list(iter_jsonl(args.state_dir / 'outcomes.jsonl'))
    section('Task outcomes by complexity band (one row per run)')
    print(f'  {"band":<10} {"n":>4} {"pass":>5} {"fail":>5} {"unk":>5} {"pass%known":>10} '
          f'{"p50 min":>8} {"p90 min":>8} {"t cov":>6} {"$ known":>9} {"$ cov":>6} {"$/verified":>10} {"fix":>5}')
    for band, s in sorted(summarize_task_outcomes(task_outcomes(orchestrated, events, outcomes)).items()):
        p50 = f'{s["elapsed_p50_ms"] / 60000:8.1f}' if s['elapsed_p50_ms'] is not None else '     n/a'
        p90 = f'{s["elapsed_p90_ms"] / 60000:8.1f}' if s['elapsed_p90_ms'] is not None else '     n/a'
        fix = f'{s["fix_rounds_mean"]:.2f}' if s['fix_rounds_mean'] is not None else 'n/a'
        print(f'  {band:<10} {s["n"]:>4} {s["pass"]:>5} {s["fail"]:>5} {s["unknown"]:>5} '
              f'{fmt_pct(s["pass_rate_known"]):>10} {p50} {p90} '
              f'{fmt_pct(s["elapsed_coverage"]):>6} {fmt_money(s["cost_known_usd"])} {fmt_pct(s["cost_complete_coverage"]):>6} '
              f'{fmt_money(s["cost_per_verified_usd"]):>10} {fix:>5}')
    print('  Descriptive only: historical runs are not a matched comparison (spec §1.4).')
```

Python 3.9 forbids reusing the enclosing quote type inside an f-string expression, which is why every lookup inside a single-quoted f-string uses double-quoted keys.

- [ ] **Step 4: Run tests and a frozen-copy smoke run**

```bash
python3 -m pytest -q tests/test_skill_vs_baseline.py
SNAP=$(mktemp -d) && cp ~/.local/state/coding-agent-orchestrator/{metrics,events,outcomes}.jsonl "$SNAP"/
python3 scripts/skill_vs_baseline.py --state-dir "$SNAP" | tail -20
```

Expected: tests PASS; the report shows `pass / fail / unknown` with `unknown` ≫ 0 and a "Task outcomes by complexity band" table. This reads a copy; the live directory is not written.

- [ ] **Step 5: Commit**

```bash
git add scripts/skill_vs_baseline.py tests/test_skill_vs_baseline.py
git commit -m "fix(report): exclude route events, treat missing result as unknown, add task-outcome bands"
```

---

### Task 8: History pass rate uses rows that carry a result

`history.build_route_stats` computes `pass_rate = successes / eff`, where `eff` includes result-less rows such as `route_executed`. This depresses dispatch pass rates in adaptive recommendations. Note: adaptive mode is `recommend` by default, so this changes recommendations, not executed routing.

**Files:**
- Modify: `orchestrator/history.py` (~line 172 `successes=…` and the `'pass_rate':` entry ~line 203)
- Test: `tests/test_history_scheduler.py`

**Interfaces:**
- Produces: `pass_rate` = weighted successes / weighted rows with a non-null `result`; `None` when no row carries a result. New key `result_samples: int`.

- [ ] **Step 1: Write the failing test** — append to `tests/test_history_scheduler.py`:

```python
def test_pass_rate_ignores_result_less_route_rows():
    from orchestrator.history import build_route_stats
    base = {'run_id': 'R', 'task_id': 'T', 'task_class': 'implementation', 'complexity': 3, 'risk': 'low',
            'capability_class': 'implementation_fast', 'effort': 'low', 'verification_depth': 'targeted'}
    rows = [dict(base, event='model_call', result='pass', cost_usd=.1, cost_source='reported', input_tokens=1, model='m'),
            dict(base, event='route_executed')]
    [group] = build_route_stats(rows)
    assert group['pass_rate'] == 1.0
    assert group['result_samples'] == 1
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest -q tests/test_history_scheduler.py -k result_less`
Expected: FAIL (`0.5 != 1.0`). If the two rows land in different groups, print `comparable_key` for both and align the fixture fields until they share one group, keeping `route_executed` result-less.

- [ ] **Step 3: Implement** — after `successes=…`:

```python
        result_weight=sum(w for x,w in weighted if x.get('result') is not None)
        result_samples=sum(1 for x,_ in weighted if x.get('result') is not None)
```

replace `'pass_rate':successes/eff if eff else None,` with:

```python
            'pass_rate':successes/result_weight if result_weight else None,
            'result_samples':result_samples,
```

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest -q tests/test_history_scheduler.py tests/test_final_integration.py tests/test_v3_engine.py tests/test_policy_recommendations.py tests/test_dashboard_golden.py`
Expected: PASS. If a golden/fixture expects the old diluted rate, confirm the fixture includes result-less rows, then update the expectation in the same commit and say so in the message.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/history.py tests/test_history_scheduler.py
git commit -m "fix(history): pass_rate denominator counts only rows with a result"
```

---

### Task 9: Reversible migration — relabel `$0` rows that reported no usage

Historical call rows with `cost_usd: 0` and no tokens read as free calls. `cost_class` already classes them `unmetered`, so dashboard numbers do not change; the migration makes the stored fact honest (`cost_usd` absent, `cost_source: 'unknown-no-usage-reported'`) with full provenance and restore.

**Files:**
- Create: `scripts/migrate_unmetered_zero_costs.py`
- Test: `tests/test_migrate_unmetered_zero_costs.py`

**Interfaces:**
- Consumes: `orchestrator.runtime.writer_lock`, `orchestrator.state.rebuild`, `orchestrator.core.env.default_state_root`, `orchestrator.economics.has_reported_tokens`, `orchestrator.records.classify`/`CALL`.
- Produces: CLI `python3 scripts/migrate_unmetered_zero_costs.py STATE_DIR [--write] [--allow-live-state] [--restore MANIFEST]`. Writes `metrics.pre-migrate-unmetered-zero-<ts>.jsonl` (backup) and `migration-unmetered-zero-<ts>.json` (manifest). Changed rows gain `migration_id: 'm20260929-unmetered-zero'`.

- [ ] **Step 1: Write the failing tests** — `tests/test_migrate_unmetered_zero_costs.py`:

```python
import json
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'migrate_unmetered_zero_costs.py'
ZERO = {'event': 'model_call', 'record_id': 'z1', 'run_id': 'R', 'model': 'unknown', 'cost_usd': 0,
        'cost_source': 'estimated-from-reported-tokens', 'input_tokens': 0, 'output_tokens': 0}
FREE = {'event': 'model_call', 'record_id': 'f1', 'run_id': 'R', 'model': 'm', 'cost_usd': 0,
        'cost_source': 'reported', 'input_tokens': 12, 'output_tokens': 3}
PAID = {'event': 'model_call', 'record_id': 'p1', 'run_id': 'R', 'model': 'm', 'cost_usd': .5, 'cost_source': 'reported'}
ROUTE = {'event': 'route_executed', 'record_id': 'x1', 'run_id': 'R', 'cost_usd': 0}
BAD_LINE = '{not json\n'


def _seed(root: Path) -> None:
    lines = [json.dumps(ZERO) + '\n', BAD_LINE, json.dumps(FREE) + '\n', json.dumps(PAID) + '\n', json.dumps(ROUTE) + '\n']
    (root / 'metrics.jsonl').write_text(''.join(lines))
    (root / 'events.jsonl').write_text('')
    (root / 'outcomes.jsonl').write_text('')


def _run(*args):
    return subprocess.run([sys.executable, str(SCRIPT), *map(str, args)], capture_output=True, text=True)


def test_dry_run_writes_nothing(tmp_path):
    _seed(tmp_path); before = (tmp_path / 'metrics.jsonl').read_bytes()
    p = _run(tmp_path)
    assert p.returncode == 0, p.stderr
    assert '"candidates": 1' in p.stdout
    assert (tmp_path / 'metrics.jsonl').read_bytes() == before
    assert not list(tmp_path.glob('migration-*.json'))


def test_write_relabels_only_zero_without_usage_and_preserves_bad_line(tmp_path):
    _seed(tmp_path)
    assert _run(tmp_path, '--write').returncode == 0
    lines = (tmp_path / 'metrics.jsonl').read_text().splitlines(keepends=True)
    assert lines[1] == BAD_LINE                       # malformed line preserved byte-for-byte
    z = json.loads(lines[0])
    assert 'cost_usd' not in z and z['cost_source'] == 'unknown-no-usage-reported'
    assert z['migration_id'] == 'm20260929-unmetered-zero'
    assert json.loads(lines[2]) == FREE               # genuinely free, measured call untouched
    assert json.loads(lines[3]) == PAID
    assert json.loads(lines[4]) == ROUTE              # decision events untouched
    [manifest] = tmp_path.glob('migration-unmetered-zero-*.json')
    m = json.loads(manifest.read_text())
    assert m['changed'] == [{'line': 1, 'record_id': 'z1', 'original': {'cost_usd': 0, 'cost_source': 'estimated-from-reported-tokens'}}]


def test_second_write_is_noop(tmp_path):
    _seed(tmp_path); _run(tmp_path, '--write')
    after_first = (tmp_path / 'metrics.jsonl').read_bytes()
    p = _run(tmp_path, '--write')
    assert '"candidates": 0' in p.stdout
    assert (tmp_path / 'metrics.jsonl').read_bytes() == after_first


def test_restore_returns_original_bytes(tmp_path):
    _seed(tmp_path); original = (tmp_path / 'metrics.jsonl').read_bytes()
    _run(tmp_path, '--write')
    [manifest] = tmp_path.glob('migration-unmetered-zero-*.json')
    assert _run(tmp_path, '--restore', manifest).returncode == 0
    assert (tmp_path / 'metrics.jsonl').read_bytes() == original


def test_refuses_live_state_without_flag(tmp_path, monkeypatch):
    _seed(tmp_path)
    p = subprocess.run([sys.executable, str(SCRIPT), str(tmp_path), '--write'], capture_output=True, text=True,
                       env={'CODING_AGENT_ORCHESTRATOR_HOME': str(tmp_path), 'PATH': '/usr/bin:/bin'})
    assert p.returncode == 2 and 'live state' in p.stderr
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest -q tests/test_migrate_unmetered_zero_costs.py`
Expected: FAIL (script does not exist).

- [ ] **Step 3: Implement** — `scripts/migrate_unmetered_zero_costs.py`:

```python
#!/usr/bin/env python3
"""Relabel historical call rows that recorded `cost_usd: 0` without any reported usage.

Such rows are not free calls; `economics.cost_class` already reads them as unmetered, so derived
numbers do not change. This makes the stored fact honest: `cost_usd` is removed and
`cost_source` becomes `unknown-no-usage-reported`. Genuinely free calls (zero cost WITH reported
tokens), decision events and already-unknown rows are untouched.

Safety (spec §1.4; same posture as audit_and_clean_metrics.py / stamp_granularity.py):
  * dry run by default; `--write` required; refuses the live state root without `--allow-live-state`;
  * read→backup→replace under the shared writer lock; atomic temp-file + fsync + os.replace;
  * malformed lines are preserved byte-for-byte, never dropped;
  * manifest records source/backup sha256 and every changed field; `--restore MANIFEST` puts the
    backup back after verifying its hash; a second `--write` is a no-op;
  * derived state (record index, ledger) is rebuilt after the lock is released.

Usage: python3 scripts/migrate_unmetered_zero_costs.py STATE_DIR [--write] [--allow-live-state] [--restore MANIFEST]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from orchestrator import records  # noqa: E402
from orchestrator.core.env import default_state_root  # noqa: E402
from orchestrator.economics import has_reported_tokens  # noqa: E402
from orchestrator.runtime import writer_lock  # noqa: E402

MIGRATION_ID = 'm20260929-unmetered-zero'
NEW_SOURCE = 'unknown-no-usage-reported'


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def _is_live(root: Path) -> bool:
    live = default_state_root()
    try:
        return live.exists() and os.path.samefile(root, live)
    except OSError:
        return root.resolve() == live.resolve()


def is_candidate(row: dict) -> bool:
    if row.get('migration_id') == MIGRATION_ID or records.classify(row) != records.CALL:
        return False
    if 'cost_usd' not in row:
        return False
    try:
        zero = float(row['cost_usd'] or 0) == 0
    except (TypeError, ValueError):
        return False
    return zero and not has_reported_tokens(row) and not str(row.get('cost_source') or '').lower().startswith('unknown')


def plan(lines: list[bytes]) -> tuple[list[bytes], list[dict]]:
    out, changed = [], []
    for i, raw in enumerate(lines, start=1):
        try:
            row = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            out.append(raw); continue
        if not isinstance(row, dict) or not is_candidate(row):
            out.append(raw); continue
        changed.append({'line': i, 'record_id': row.get('record_id'),
                        'original': {'cost_usd': row.get('cost_usd'), 'cost_source': row.get('cost_source')}})
        row.pop('cost_usd', None)
        row['cost_source'] = NEW_SOURCE
        row['migration_id'] = MIGRATION_ID
        out.append((json.dumps(row, sort_keys=True) + '\n').encode('utf-8'))
    return out, changed


def _atomic_write(target: Path, chunks: list[bytes]) -> None:
    fd, tmp = tempfile.mkstemp(dir=str(target.parent), prefix=f'.{target.name}.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'wb') as fh:
            for c in chunks:
                fh.write(c)
            fh.flush(); os.fsync(fh.fileno())
        os.replace(tmp, target)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _rebuild(root: Path) -> None:
    from orchestrator.state import rebuild  # takes the writer lock itself; call after release
    rebuild(root)


def restore(root: Path, manifest_path: Path) -> int:
    m = json.loads(manifest_path.read_text())
    backup = Path(m['backup'])
    if _sha256(backup) != m['backup_sha256']:
        print('error: backup hash mismatch; refusing to restore', file=sys.stderr); return 1
    with writer_lock(root):
        _atomic_write(root / 'metrics.jsonl', [backup.read_bytes()])
    _rebuild(root)
    print(json.dumps({'restored_from': str(backup)}))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument('state_dir', type=Path)
    p.add_argument('--write', action='store_true')
    p.add_argument('--allow-live-state', action='store_true')
    p.add_argument('--restore', type=Path)
    a = p.parse_args(argv)
    root: Path = a.state_dir
    if (a.write or a.restore) and _is_live(root) and not a.allow_live_state:
        print('error: refusing to modify the live state root without --allow-live-state', file=sys.stderr)
        return 2
    if a.restore:
        return restore(root, a.restore)
    metrics = root / 'metrics.jsonl'
    if not a.write:
        _, changed = plan(metrics.read_bytes().splitlines(keepends=True))
        print(json.dumps({'mode': 'dry-run', 'candidates': len(changed)}))
        return 0
    with writer_lock(root):
        source_sha = _sha256(metrics)
        new_lines, changed = plan(metrics.read_bytes().splitlines(keepends=True))
        if not changed:
            print(json.dumps({'mode': 'write', 'candidates': 0}))
            return 0
        ts = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        backup = root / f'metrics.pre-migrate-unmetered-zero-{ts}.jsonl'
        shutil.copy2(metrics, backup)
        if _sha256(backup) != source_sha:
            print('error: backup verification failed', file=sys.stderr); return 1
        manifest = root / f'migration-unmetered-zero-{ts}.json'
        manifest.write_text(json.dumps({'migration_id': MIGRATION_ID, 'source_sha256': source_sha,
                                        'backup': str(backup), 'backup_sha256': source_sha,
                                        'changed': changed}, indent=2))
        _atomic_write(metrics, new_lines)
    _rebuild(root)
    print(json.dumps({'mode': 'write', 'candidates': len(changed), 'backup': str(backup), 'manifest': str(manifest)}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
```

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest -q tests/test_migrate_unmetered_zero_costs.py tests/test_maintenance_scripts.py`
Expected: PASS. If `state.rebuild` needs files beyond the three streams in a temp root, seed them in `_seed` the way `tests/test_maintenance_scripts.py` seeds its roots.

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate_unmetered_zero_costs.py tests/test_migrate_unmetered_zero_costs.py
git commit -m "feat(migration): reversible relabel of zero-cost rows without usage"
```

---

### Task 10: Baseline runbook and docs

Document how to produce the frozen "before" snapshot and keep the skill's performance-evidence text accurate.

**Files:**
- Create: `docs/EVAL_BASELINE.md`
- Modify: `SKILL.md` — "Performance evidence" subsection only. `SKILL.md` has unrelated uncommitted edits: stage this hunk only with `git add -p SKILL.md`.
- Test: `tests/test_packaging.py` already checks shipped docs; no new test file. Verification is the frozen-copy run below.

- [ ] **Step 1: Write `docs/EVAL_BASELINE.md`**

````markdown
# Producing the Phase 0 baseline

Descriptive "current behaviour" numbers, per complexity band, from a frozen copy of state.
Not a matched comparison; see the tiered-workflows spec §1.4 and §2.

## 1. Freeze a snapshot

```bash
SNAP=~/orch-baseline-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$SNAP"
cp ~/.local/state/coding-agent-orchestrator/{metrics,events,outcomes}.jsonl "$SNAP"/
shasum -a 256 "$SNAP"/*.jsonl > "$SNAP/SHA256SUMS"
git -C <skill checkout> rev-parse HEAD > "$SNAP/REVISION"
```

## 2. Report

```bash
python3 scripts/skill_vs_baseline.py --state-dir "$SNAP" > "$SNAP/report.txt"
```

Read `pass / fail / unknown`, the band table and its coverage columns. A band whose
`t cov` or `$ cov` is low cannot support time or cost claims.

## 3. Optional: relabel zero-cost rows (human-run, live state)

```bash
python3 scripts/migrate_unmetered_zero_costs.py ~/.local/state/coding-agent-orchestrator            # dry run
python3 scripts/migrate_unmetered_zero_costs.py ~/.local/state/coding-agent-orchestrator --write --allow-live-state
# undo: … --restore <manifest path printed by --write> --allow-live-state
```

Run only when no `/orchestrate` run or ingest is active. Derived numbers do not change.

## 4. Record delayed defects

```bash
python3 -m orchestrator.cli defect-link <run_id> --type revert --severity high --evidence <sha>
python3 -m orchestrator.cli defect-link <run_id> --type bug_traced --severity medium --evidence <issue> --attribution human_confirmed --confirmed
```

Only `--confirmed` links count against a run.

## Exit gate (spec §1.5)

Over a predefined window of new runs: ≥95% have terminal timing and an evidence-backed
verification; every `run_started` is accounted for (completed/failed/cancelled/interrupted/unknown).
````

- [ ] **Step 2: Update `SKILL.md` "Performance evidence"** — replace the paragraph starting "To evaluate whether the orchestrator is earning its keep" with:

```markdown
To evaluate whether the orchestrator is earning its keep, follow `docs/EVAL_BASELINE.md`: freeze a snapshot, then run `scripts/skill_vs_baseline.py --state-dir <snapshot>`. It excludes decision/route events from work, reports missing results as `unknown` (never `fail`), and prints one task outcome per run by complexity band with time/cost coverage. Flat-model repricing remains a cost sensitivity analysis, not a no-orchestration experiment; matched comparisons come from the benchmark in the tiered-workflows spec.
```

- [ ] **Step 3: Verify on a frozen copy**

```bash
SNAP=$(mktemp -d) && cp ~/.local/state/coding-agent-orchestrator/{metrics,events,outcomes}.jsonl "$SNAP"/
python3 scripts/skill_vs_baseline.py --state-dir "$SNAP" | grep -A8 "Task outcomes by complexity band"
python3 -m pytest -q && (cd bridge/extensions/orchestrator && bun test) && bash scripts/lint.sh
```

Expected: band table prints; full Python and bridge suites PASS; lint exit 0 (or 2 = tools missing, report as skipped).

- [ ] **Step 4: Commit**

```bash
git add docs/EVAL_BASELINE.md
git add -p SKILL.md   # stage only the Performance evidence hunk
git commit -m "docs: Phase 0 baseline runbook and corrected performance-evidence guidance"
```

---

## Spec coverage (Section 1)

| Spec item | Task |
|---|---|
| §1.1 one normalized outcome per run, status vs verification, missing = unknown | 5 |
| §1.1 lifecycle/crash reconciliation reuse | 2 (+ existing `classify_liveness`) |
| §1.2 failed-dispatch usage provenance, never `$0` for unreported usage | 4, 9 |
| §1.2 end-to-end elapsed, no summed parallel durations | 2, 5 (reads run elapsed, never dispatch sums) |
| §1.3 fix rounds vs provider retries | 3, 4 |
| §1.3 defect links, confirmed-only, shared `bad_signal` | 1, 6 |
| §1.4 shared classification in analysis; decision events excluded | 7, 8 |
| §1.4 safe reversible historical rewrite | 9 |
| §1.5 baseline report and exit gate | 7, 10 |

Deferred to later plans, by design: per-phase span timing and human-wait time (needs bridge span instrumentation; Phase 1 plan), `task_instance_id` across continuations and experiment-assignment fields (Phase 1 harness), escalation counters (Phase 2 tiers).

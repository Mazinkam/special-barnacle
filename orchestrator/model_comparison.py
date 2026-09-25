"""Offline, report-only comparison of model-canary cohorts.

This module answers *one* question — "what did the baseline arm and the candidate arm of a
model-canary actually cost and verify, in comparable strata?" — and refuses to answer any other.
It never routes, never recommends promotion, and never renders a savings or quality-equivalence
claim: `claim_supported` is hardcoded `False` everywhere, and the strongest thing a caller may
print is `sufficient_samples: true` alongside the raw counts.

Cost provenance, dedup, and the model-call population come from `economics`/`records` — this
module does not re-derive "was this cost measured?" or "is this row a call?": see
`economics.cost_class`, `economics.is_call_row`, `economics.unique_records`. Verification evidence
comes from `records.resolve_task_verification` (attested-only, conservative-tie-break) exactly as
`run_evidence` and `history` read it. Delayed-outcome bad-signal detection reuses
`outcomes.bad_signal`; only the "how old is this outcome, given `now`" glue is local, because
`outcomes.outcome_summary` hardcodes `datetime.now()` and this module must be able to take a fixed
`now` for deterministic tests.

Canary fields (bridge-emitted, flat, on `model_call` rows):
`canary_cohort` ('baseline'|'candidate'|'ineligible'), `canary_candidate_id`, `canary_activation`,
`canary_policy_version`, `baseline_model`, `candidate_model`, `requested_model`, `executed_model`,
`canary_attempt_id`, `canary_deviation`, `experiment_flags` (list of enabled efficiency-switch
names, e.g. `["scoped_leads"]` — never model-related, so any non-empty list confounds a model
comparison unless the caller explicitly opts in with `allow_confounded=True`).

Nested subagent detail rows (bridge `nestedModelCallRowsFor`, tagged `nested: True`, identified by
`economics._is_nested_detail_row`) carry NONE of the above — only `run_id` and `parent_task_id`
(the parent dispatch's own `task_id`). `_attribute_nested_rows` joins each one to its parent row
and inherits the parent's cohort/candidate/stratum before grouping; see that function for the full
rule, including how an unattributable nested row (no matching parent at all) is surfaced.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any, Iterable

from . import outcomes as outcomes_mod
from . import records
from .economics import (
    ESTIMATED,
    REPORTED,
    _is_nested_detail_row,
    cost_class,
    is_call_row,
    row_cost,
    unique_records,
)
from .history import bucket_complexity
from .records import NO_DATA, ratio

__all__ = ['compare_canary_cohorts', 'format_comparison']

BASELINE = 'baseline'
CANDIDATE = 'candidate'
_ARMS = (BASELINE, CANDIDATE)

_TERMINAL_TASK_IDS = frozenset({'run-complete', 'run-failed', 'run-cancelled'})


def _capability(row: dict) -> str:
    return str(row.get('capability_class') or row.get('role') or 'unknown')


def _stratum_key(row: dict, width: int = 2) -> tuple:
    return (
        row.get('task_class') or 'unknown',
        row.get('risk') or 'medium',
        bucket_complexity(row.get('complexity', 5), width),
        row.get('repo') or 'unknown',
        row.get('canary_policy_version') or 'unknown',
    )


def _is_run_scoped_outcome(o: dict) -> bool:
    """A run-gate outcome row, never a task attempt — mirrors `run_evidence._is_run_scoped`."""
    tid = str(o.get('task_id') or '')
    return o.get('verification_scope') == 'run' or tid in _TERMINAL_TASK_IDS or tid.endswith('-qa')


def _task_age_days(task_outcomes: list[dict], now: datetime) -> int | None:
    """Age of the earliest outcome observed for one task, or `None` when none carries a usable
    timestamp — mirrors `outcomes.outcome_summary`'s own age computation, but against a caller-
    supplied `now` so tests can be deterministic (`outcome_summary` hardcodes `datetime.now()`)."""
    times: list[datetime] = []
    for o in task_outcomes:
        ts = o.get('completed_at') or o.get('ts')
        if not ts:
            continue
        try:
            dt = datetime.fromisoformat(str(ts).replace('Z', '+00:00'))
        except (TypeError, ValueError):
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        times.append(dt)
    if not times:
        return None
    return (now - min(times)).days


def _cost_stats(rows_in_arm: list[dict]) -> dict[str, Any]:
    reported = 0.0
    estimated = 0.0
    call_rows = 0
    unknown_rows = 0
    for r in rows_in_arm:
        if not is_call_row(r):
            continue
        call_rows += 1
        klass = cost_class(r)
        if klass == REPORTED:
            reported += row_cost(r)
        elif klass == ESTIMATED:
            estimated += row_cost(r)
        else:
            unknown_rows += 1
    known_usd = reported + estimated
    return {
        'reported_usd': reported,
        'estimated_usd': estimated,
        'known_usd': known_usd,
        'call_rows': call_rows,
        'unknown_cost_rows': unknown_rows,
        'coverage': ratio(call_rows - unknown_rows, call_rows),
        'complete': call_rows > 0 and unknown_rows == 0,
    }


def _arm_stats(rows_in_arm: list[dict], outcomes_by_key: dict[tuple, list[dict]], now: datetime) -> dict[str, Any]:
    runs = len({r.get('run_id') for r in rows_in_arm if r.get('run_id') is not None})
    attempt_rows = [r for r in rows_in_arm if not r.get('_attributed_nested_row')]
    runs = len({r.get('run_id') for r in attempt_rows if r.get('run_id') is not None})
    attempts = len(attempt_rows)
    deviations = Counter(r.get('canary_deviation') for r in attempt_rows if r.get('canary_deviation'))

    cost = _cost_stats(rows_in_arm)
    nested_cost_by_role: dict[str, dict[str, Any]] = {}
    for role in sorted({str(r.get('role') or 'unknown') for r in rows_in_arm if r.get('_attributed_nested_row')}):
        role_stats = _cost_stats([r for r in rows_in_arm if r.get('_attributed_nested_row') and str(r.get('role') or 'unknown') == role])
        nested_cost_by_role[role] = {'known_usd': role_stats['known_usd'], 'unknown_rows': role_stats['unknown_cost_rows']}

    task_keys = {(r.get('run_id'), r.get('task_id')) for r in attempt_rows if r.get('task_id') is not None}
    by_task: dict[tuple, list[dict]] = defaultdict(list)
    for r in attempt_rows:
        if r.get('task_id') is not None:
            by_task[(r.get('run_id'), r.get('task_id'))].append(r)

    verified = failed = unverified = 0
    delayed_bad = 0
    immature = 0
    for key in task_keys:
        task_outcomes = [o for o in outcomes_by_key.get(key, []) if not _is_run_scoped_outcome(o)]
        combined = by_task[key] + task_outcomes
        verdict = records.resolve_task_verification(combined)
        if verdict.strength == records.ATTESTED and verdict.state == records.VERIFIED:
            verified += 1
        elif verdict.strength == records.ATTESTED:
            failed += 1
        else:
            unverified += 1

        if not task_outcomes:
            immature += 1
            continue
        age_days = _task_age_days(task_outcomes, now)
        if age_days is None or age_days < 30:
            immature += 1
        if any(outcomes_mod.bad_signal(o) for o in task_outcomes):
            delayed_bad += 1

    cost_per_verified_outcome = None
    if verified > 0 and cost['complete']:
        cost_per_verified_outcome = cost['known_usd'] / verified

    return {
        'runs': runs,
        'attempts': attempts,
        'deviations': dict(deviations),
        'cost': cost,
        'nested_cost_by_role': nested_cost_by_role,
        'outcomes': {'verified': verified, 'failed': failed, 'unverified': unverified},
        'delayed': {'bad': delayed_bad, 'immature': immature},
        'cost_per_verified_outcome': cost_per_verified_outcome,
    }


def _is_confounding(row: dict) -> bool:
    """`experiment_flags` names efficiency switches, never model-routing switches — any non-empty
    list confounds a model-vs-model comparison, whatever the flag is named."""
    flags = row.get('experiment_flags')
    return bool(flags) and isinstance(flags, (list, tuple, set))


#: Canary/stratum fields a nested detail row never carries on its own (bridge
#: `nestedModelCallRowsFor` — see module docstring) but that this module's grouping/stratum logic
#: reads — so a nested row attributed to a parent inherits exactly these, and nothing else about
#: the parent (its own identity, cost, and role/capability stay the nested row's own).
_INHERITED_FROM_PARENT = (
    'canary_cohort', 'canary_candidate_id', 'canary_policy_version', 'canary_deviation',
    'experiment_flags', 'task_class', 'risk', 'complexity', 'repo',
)


def _attribute_nested_rows(rows: list[dict]) -> tuple[list[dict], int]:
    """Attribute nested subagent detail rows to the canary cohort of their parent dispatch.

    `economics._is_nested_detail_row` rows (the bridge's `nestedModelCallRowsFor` per-task rows,
    and any `nested_residual` rows `economics.nested_reconciliation` synthesized upstream for an
    unexplained aggregate gap — both share the same `nested: True` / `parent_task_id` shape) carry
    NO canary fields at all: only `run_id` and `parent_task_id`, which identify the parent DISPATCH
    row's own `(run_id, task_id)`, never a cohort. Left alone, every dollar of nested subagent
    spend under a canary-tagged dispatch would be silently excluded from `compare_canary_cohorts`
    — the bug this function exists to close.

    Each nested row is joined to the direct (non-nested) row sharing its `(run_id, parent_task_id)`
    identity — the only identity a nested row actually carries (see `nestedModelCallRowsFor`) — and
    inherits that parent's cohort/candidate/stratum (`_INHERITED_FROM_PARENT`). Its own identity
    (`task_id`, cost fields, `role`/`capability_class`, `record_id`) is untouched, so it still groups
    by ITS OWN capability, not the dispatch's.

    Three outcomes, never a guess:
    * Parent found and canary-eligible (`canary_cohort` in `{baseline, candidate}` with a
      `canary_candidate_id`) — an inherited COPY is appended to the returned list; the original
      nested row is left in place too (it has no `canary_cohort` of its own, so the grouping loop
      below simply does not select it — no double count).
    * Parent found but not canary-eligible (ineligible cohort, no candidate id) — the nested row
      correctly has nothing to inherit and is left out of every group, exactly like its parent.
    * Parent not found AT ALL (no row shares its `(run_id, parent_task_id)` identity) — counted in
      the returned `unattributed_nested_rows` total instead of being dropped without a trace or
      guessed into some arm.

    Never double-books an aggregate total against its own detail: this module only ever reads
    `model_call`-shaped rows (a `dispatch_finished` aggregate event never carries a `canary_cohort`
    and is excluded from grouping regardless), and `economics.nested_reconciliation` upstream
    already guarantees a `nested_cost_usd` aggregate and its durable detail rows are never both
    present as call rows for the same `(run_id, task_id, dispatch_attempt)` — this function only
    reassigns cohort attribution over whatever detail population it is handed, never re-derives
    "how much nested cost existed".
    """
    direct_by_key: dict[tuple, dict] = {}
    for row in rows:
        if _is_nested_detail_row(row):
            continue
        task_id = row.get('task_id')
        if task_id is None:
            continue
        key = (row.get('run_id'), task_id)
        if key not in direct_by_key:
            direct_by_key[key] = row

    attributed: list[dict] = []
    unattributed = 0
    for row in rows:
        if not _is_nested_detail_row(row):
            continue
        parent = direct_by_key.get((row.get('run_id'), row.get('parent_task_id')))
        if parent is None:
            unattributed += 1
            continue
        cohort = parent.get('canary_cohort')
        if cohort not in _ARMS or not parent.get('canary_candidate_id'):
            continue  # parent exists but isn't canary-tracked: not part of this comparison
        inherited = dict(row)
        for field in _INHERITED_FROM_PARENT:
            inherited[field] = parent.get(field)
        inherited['capability_class'] = _capability(parent)
        inherited['_attributed_nested_row'] = True
        attributed.append(inherited)

    return rows + attributed, unattributed


def compare_canary_cohorts(
    rows: Iterable[dict],
    outcomes: Iterable[dict] = (),
    *,
    min_samples_per_arm: int = 30,
    allow_confounded: bool = False,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Report-only comparison of baseline vs candidate model-canary cohorts.

    Groups deduped, canary-eligible `model_call` rows by `(candidate_id, capability)`, then by a
    comparable stratum (`task_class`, `risk`, a complexity bucket via `history.bucket_complexity`,
    `repo`, `canary_policy_version`). Rows with `canary_cohort` outside `{baseline, candidate}`, or
    with no `canary_candidate_id`, do not participate (they are simply not canary-tracked
    comparisons — `ineligible_rows` counts only the rows explicitly marked `canary_cohort:
    'ineligible'`). Rows carrying any `experiment_flags` are excluded as `confounded_excluded`
    unless `allow_confounded=True` — `experiment_flags` names non-model efficiency switches, which
    are never part of what a model-canary comparison is trying to isolate.

    Nested subagent detail rows (bridge `nestedModelCallRowsFor`, tagged `nested: True`) carry no
    canary fields of their own; each is first attributed to its parent dispatch row and inherits
    that row's cohort/candidate/stratum (`_attribute_nested_rows`) before grouping, so nested spend
    under a canary-tagged dispatch is not silently excluded. A nested row whose parent cannot be
    found at all is counted in `unattributed_nested_rows` instead of being dropped or guessed at.

    Returns a pure, JSON-shaped `dict`; never mutates `rows`/`outcomes`. `now` defaults to
    `datetime.now(timezone.utc)` when omitted, and exists so callers (and tests) can pin the
    "how mature is this outcome" clock.
    """
    now = now or datetime.now(timezone.utc)
    rows = list(unique_records(rows))
    outcomes = list(unique_records(outcomes))
    rows, unattributed_nested_rows = _attribute_nested_rows(rows)

    outcomes_by_key: dict[tuple, list[dict]] = defaultdict(list)
    for o in outcomes:
        if o.get('task_id') is not None:
            outcomes_by_key[(o.get('run_id'), o.get('task_id'))].append(o)

    ineligible_rows = 0
    confounded_excluded = 0
    # groups[(candidate_id, capability)][stratum][arm] -> list[row]
    groups: dict[tuple, dict[tuple, dict[str, list[dict]]]] = defaultdict(lambda: defaultdict(lambda: {a: [] for a in _ARMS}))

    for row in rows:
        cohort = row.get('canary_cohort')
        candidate_id = row.get('canary_candidate_id')
        if cohort == 'ineligible':
            ineligible_rows += 1
            continue
        if cohort not in _ARMS or not candidate_id:
            continue  # not canary-tracked at all: not part of this comparison
        if _is_confounding(row) and not allow_confounded:
            confounded_excluded += 1
            continue
        key = (candidate_id, _capability(row))
        stratum = _stratum_key(row)
        groups[key][stratum][cohort].append(row)

    group_reports = []
    for (candidate_id, capability) in sorted(groups, key=lambda k: (str(k[0]), k[1])):
        strata_reports = []
        for stratum in sorted(groups[(candidate_id, capability)], key=lambda s: tuple(str(x) for x in s)):
            arms_rows = groups[(candidate_id, capability)][stratum]
            task_class, risk, complexity_bucket, repo, policy_version = stratum

            baseline_rows = arms_rows[BASELINE]
            candidate_rows = arms_rows[CANDIDATE]
            baseline = _arm_stats(baseline_rows, outcomes_by_key, now) if baseline_rows else None
            candidate = _arm_stats(candidate_rows, outcomes_by_key, now) if candidate_rows else None

            notes = []
            baseline_n = baseline['attempts'] if baseline else 0
            candidate_n = candidate['attempts'] if candidate else 0
            notes.append(f'baseline: {baseline_n} attempts, candidate: {candidate_n} attempts')

            sufficient_samples = bool(
                baseline and candidate
                and baseline_n >= min_samples_per_arm
                and candidate_n >= min_samples_per_arm
                and baseline['cost']['complete']
                and candidate['cost']['complete']
            )
            if not sufficient_samples:
                if not baseline or not candidate:
                    notes.append('one arm has zero exposure in this stratum')
                elif baseline_n < min_samples_per_arm or candidate_n < min_samples_per_arm:
                    notes.append(f'below min_samples_per_arm ({min_samples_per_arm})')
                elif not (baseline['cost']['complete'] and candidate['cost']['complete']):
                    notes.append('cost incomplete (unknown-cost rows present) in at least one arm')

            for name, arm in (('baseline', baseline), ('candidate', candidate)):
                if arm and arm['delayed']['immature']:
                    notes.append(f"{name}: {arm['delayed']['immature']} task(s) with immature/missing delayed outcomes")

            strata_reports.append({
                'task_class': task_class,
                'risk': risk,
                'complexity_bucket': complexity_bucket,
                'repo': repo,
                'policy_version': policy_version,
                'baseline': baseline,
                'candidate': candidate,
                'sufficient_samples': sufficient_samples,
                'claim_supported': False,
                'notes': notes,
            })
        group_reports.append({
            'candidate_id': candidate_id,
            'capability': capability,
            'strata': strata_reports,
        })

    return {
        'schema_version': 1,
        'ineligible_rows': ineligible_rows,
        'confounded_excluded': confounded_excluded,
        'unattributed_nested_rows': unattributed_nested_rows,
        'groups': group_reports,
    }


def _fmt_usd(value: Any) -> str:
    if value is None or value is NO_DATA:
        return 'n/a'
    return f'${value:,.4f}'


def _fmt_arm(name: str, arm: dict | None) -> list[str]:
    if arm is None:
        return [f'  {name}: no exposure']
    cost = arm['cost']
    lines = [
        f"  {name}: runs={arm['runs']} attempts={arm['attempts']} "
        f"cost_known={_fmt_usd(cost['known_usd'])} (reported={_fmt_usd(cost['reported_usd'])}, "
        f"estimated={_fmt_usd(cost['estimated_usd'])}) unknown_cost_rows={cost['unknown_cost_rows']} "
        f"cost_complete={cost['complete']}",
        f"    outcomes: verified={arm['outcomes']['verified']} failed={arm['outcomes']['failed']} "
        f"unverified={arm['outcomes']['unverified']} cost_per_verified_outcome="
        f"{_fmt_usd(arm['cost_per_verified_outcome'])}",
        f"    delayed: bad={arm['delayed']['bad']} immature={arm['delayed']['immature']}",
    ]
    if arm['deviations']:
        lines.append(f"    deviations: {dict(arm['deviations'])}")
    return lines


def format_comparison(report: dict[str, Any]) -> str:
    """Render `compare_canary_cohorts`'s report as readable text — no claims, only counts."""
    lines = [
        f"canary comparison (ineligible_rows={report['ineligible_rows']}, "
        f"confounded_excluded={report['confounded_excluded']}, "
        f"unattributed_nested_rows={report['unattributed_nested_rows']})",
    ]
    if not report['groups']:
        lines.append('no canary-eligible cohorts found')
        return '\n'.join(lines)
    for group in report['groups']:
        lines.append(f"candidate={group['candidate_id']} capability={group['capability']}")
        for stratum in group['strata']:
            lines.append(
                f"  stratum task_class={stratum['task_class']} risk={stratum['risk']} "
                f"complexity={stratum['complexity_bucket']} repo={stratum['repo']} "
                f"policy_version={stratum['policy_version']} "
                f"sufficient_samples={stratum['sufficient_samples']} claim_supported=False"
            )
            lines.extend(_fmt_arm('baseline', stratum['baseline']))
            lines.extend(_fmt_arm('candidate', stratum['candidate']))
            for note in stratum['notes']:
                lines.append(f'    note: {note}')
    return '\n'.join(lines)

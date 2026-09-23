"""Record classification and vocabulary normalization — the one seam every metric consumer reads through.

Three unrelated kinds of record share one flat shape in `metrics.jsonl`:

* a single model call (`event=='model_call'`, per-call granularity),
* a whole *session* rolled into one row (`covers_calls`, `granularity=='session'`, or the
  historical `legacy_source` aggregates — one of which claims 33,177,381 input tokens),
* a non-cost-bearing orchestration *event* (`route_executed`, `adaptive_route_decision`, …).

Mixing them is what produced a `4053665000.0×` tail ratio and a 13x-understated call count:
percentiles ran over rows, not calls, and 195 of 410 orchestrated rows carry no `cost_usd` at all.
This module answers "what kind of record is this?" and "what does this row say about verification?"
so that no consumer has to re-derive it from raw keys.

Vocabulary also drifted across streams: `metrics.jsonl` says `result: pass`, `outcomes.jsonl` says
`outcome: verified`, some rows only carry `success: true`. `verification_state` is the only place
that knowledge lives.

Verification evidence additionally has a *strength*, and flattening it was its own falsehood: see
`verification_evidence` for why a `result: pass` dispatch row is not a verification verdict, and
`resolve_task_verification` for why contradictory evidence about one task resolves to *not verified*.

`NO_DATA` exists because `0` was being used as the null. A measured zero and an unmeasured field are
different claims and the dashboard must be able to render them differently.
"""
from __future__ import annotations

from typing import Any, Iterable, Mapping, NamedTuple

# --- granularity -----------------------------------------------------------------------------

CALL = 'call'
SESSION = 'session'
EVENT = 'event'
GRANULARITIES = (CALL, SESSION, EVENT)

#: Orchestration records that describe coordination, not billable model work. They may carry
#: *other* cost fields (`route_executed.executed_cost_usd`) but never `cost_usd`, so counting them
#: as calls drags every per-call percentile toward zero. Exported so consumers that need the event
#: test on its own (independent of `classify`'s precedence) do not re-hardcode the list.
NON_COST_EVENTS = frozenset({
    'route_executed',
    'adaptive_route_decision',
    'task_verified',
    'task_failed',
    'verification_result',
    'context_packet',
    'shadow_review',
    'decision_invalidated',
})

_COST_FIELDS = ('cost_usd', 'ci_cost_usd', 'human_cost_usd')


def _number(value: Any) -> float:
    """Coerce a telemetry value to a float without ever raising.

    Live rows carry `None`, `''`, and numeric strings for the same field depending on which runtime
    wrote them. `economics.row_cost` already tolerates `None`/`''` via `float(x or 0)`; this adds
    tolerance for junk (`'n/a'`) because a single malformed row must not crash dashboard generation.
    Numeric results are identical to the original expression for every well-formed value.
    """
    if value is None or isinstance(value, bool):
        return 0.0
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def row_cost(row: Mapping[str, Any]) -> float:
    """Total dollars a row is accountable for: model spend plus CI plus human time.

    Defined here rather than imported from `economics` because `economics` must import *this*
    module (T2) and a cycle would break `from orchestrator import records`. `economics.row_cost`
    is expected to delegate to (or re-export) this function so there is exactly one definition of
    what a row costs.
    """
    return sum(_number(row.get(field)) for field in _COST_FIELDS)


def classify(row: Mapping[str, Any]) -> str:
    """Return `SESSION`, `EVENT`, or `CALL` for one telemetry row.

    Precedence is `SESSION > EVENT > CALL`, and the order is load-bearing:

    * `SESSION` first because a session aggregate is the most expensive misread. One such row can
      hold $10.12 and 33M input tokens; treating it as a call corrupts percentiles, tail ratios and
      per-call cost in one step. A row that declares itself an aggregate is an aggregate even when
      it also names an event (the `legacy_source` stream stamped `adaptive_route_decision` rows too).
    * `EVENT` before `CALL` because `event=='model_call'` is not the only cost-shaped event name;
      `route_executed` carries `executed_cost_usd` and would otherwise read as a $0 call and pull
      p50 to zero.
    * `CALL` is the residual: an ordinary per-call `model_call` row, or any unrecognized row. The
      residual is the *safe* default only in combination with `is_per_call_cost_row`, which also
      requires a positive cost before a row joins a per-call population.
    """
    if row.get('covers_calls') or row.get('granularity') == SESSION or 'legacy_source' in row:
        return SESSION
    if row.get('event') in NON_COST_EVENTS:
        return EVENT
    return CALL


def covered_calls(row: Mapping[str, Any]) -> int:
    """How many real model calls this row represents.

    Session aggregates state it in `covers_calls` (609 live rows summing 85,246 calls); every other
    row stands for exactly one call. Counting rows instead of calls understated interactive volume
    13-fold, so any "calls" figure must sum this rather than use `len(rows)`. Non-positive or
    unparseable values fall back to 1: a row that exists represents at least one call.
    """
    covered = int(_number(row.get('covers_calls')))
    return covered if covered > 0 else 1


def is_per_call_cost_row(row: Mapping[str, Any]) -> bool:
    """The population for per-call cost statistics (percentiles, tail ratio, per-call attribution).

    Two exclusions, both from live-data failures: session aggregates (wrong granularity — their cost
    covers many calls) and event rows (no `cost_usd` at all — 195 of 410 orchestrated rows, which is
    why p50 was $0.0000). Cost must be strictly positive: an unmetered call is real work, but it
    carries no measurement and so cannot contribute a cost sample. Track unmetered coverage through
    `economics.cost_attribution`, not through this predicate.
    """
    return classify(row) == CALL and row_cost(row) > 0


# --- verification vocabulary ----------------------------------------------------------------

VERIFIED = 'verified'
FAILED = 'failed'
PARTIAL = 'partial'

#: How strong the evidence behind a verdict is. These are *not* interchangeable and no consumer may
#: pool them into a single "verified" figure — that pooling is the defect documented on
#: `verification_evidence`.
#:
#: `ATTESTED` — something *states a verdict about the task*: the canonical events `task_verified` /
#: `task_failed`, or one of `_ATTESTED_KEYS`, the fields the post-hoc outcomes stream uses to record
#: a judgement it was written specifically to record.
#:
#: `DISPATCH` — a `result` value (pass/fail) on a dispatch row. Real, useful, and a much weaker
#: claim: it reports that a subprocess exited 0, not that the work cleared its quality gates.
ATTESTED = 'attested'
DISPATCH = 'dispatch'
EVIDENCE_STRENGTHS = (ATTESTED, DISPATCH)

_VERIFICATION_WORDS = {
    'verified': VERIFIED, 'pass': VERIFIED, 'success': VERIFIED, 'true': VERIFIED,
    'fail': FAILED, 'failed': FAILED, 'blocked': FAILED, 'false': FAILED,
    'partial': PARTIAL,
}

#: Events by which an emitter states a verdict about a task outright. Attested by construction: the
#: runtime that ran the work is reporting the gate outcome, not a process exit.
_ATTESTING_EVENTS = {'task_verified': VERIFIED, 'task_failed': FAILED}

#: Verdict fields that carry an *attestation*. These are the fields the outcomes stream uses to
#: record a post-hoc judgement (`outcome: verified` on 55 live rows, boolean `success` on 7, `kind`
#: for delayed/acceptance verdicts), so a value here is a statement about the task.
_ATTESTED_KEYS = ('outcome', 'success', 'kind')

#: Verdict fields that carry only *dispatch* evidence. `result` is written by the dispatch path on
#: `model_call` rows and means "the subprocess exited 0".
_DISPATCH_KEYS = ('result',)

#: Checked in order; the first key whose value is a recognized spelling wins. Attested keys are
#: checked before `result` so that a row carrying both is reported at its strongest: an explicit
#: verdict about the task outranks the exit status of the attempt that produced it.
_VERIFICATION_KEYS = _ATTESTED_KEYS + _DISPATCH_KEYS


def _word(value: Any) -> str | None:
    if isinstance(value, bool):
        return _VERIFICATION_WORDS.get('true' if value else 'false')
    if value is None:
        return None
    return _VERIFICATION_WORDS.get(str(value).strip().lower())


class VerificationEvidence(NamedTuple):
    """A verdict plus how strong the evidence for it is.

    `state` is `'verified' | 'failed' | 'partial' | None`; `strength` is `ATTESTED` | `DISPATCH`, and
    is `None` exactly when `state` is `None`. Unpacks as a plain tuple, so
    `state, strength = verification_evidence(row)` works.
    """

    state: str | None
    strength: str | None


#: The answer for a row that makes no verification claim at all. A singleton so callers can compare.
NO_VERIFICATION = VerificationEvidence(None, None)


def verification_evidence(row: Mapping[str, Any]) -> VerificationEvidence:
    """Normalize a row's verdict *and report how strong the evidence is*.

    DO NOT "simplify" this by treating a `result: 'pass'` row as a verification. That flattening is
    the bug this function exists to prevent, and it is not a hypothetical:

    * `result` on a `model_call` row is written by the *dispatch* path. `pass` means the dispatched
      subprocess exited 0. It is not a claim that the task cleared its quality gates.
    * Measured on the live stream: 164 task ids have a dispatch `result == 'pass'`, while only 18
      have an attested verified verdict, and 148 have a dispatch pass with no attestation of any
      kind. Counting dispatch passes as verifications reported `Verified tasks 174` — roughly a 10x
      overstatement — and populated `verified_cost_usd` for 75 of 85 route groups from a signal that
      never measured verification.
    * Presenting a process exit code as gate verification is a semantically different signal rendered
      as a measured fact, which is the whole class of defect this module was introduced to remove.

    So strength is explicit. Consumers that answer "was this verified?" must require `ATTESTED`;
    consumers that answer "did dispatch succeed?" (e.g. `history` `pass_rate`) may use `DISPATCH`.

    Strength is derived from the row's *own shape*, never from which file it came from. The same
    function is called on rows from `metrics.jsonl` and `outcomes.jsonl`, and a metrics row carrying
    `event: 'task_verified'` IS attested — `engine.Engine.verify_task` emits it from a graded
    `QualityEvidence`, which is what makes the event worth trusting. The bridge deliberately does
    NOT emit one: it had no per-task gate verdict to report, only dispatch exit codes, so emitting
    the event there reintroduced the 174-vs-22 overstatement under a new name. See
    `dispatchRecordsFor` in `bridge/extensions/orchestrator/index.ts`. Because a writer can get this
    wrong, `resolve_task_verification` breaks contradictions conservatively rather than trusting any
    single attested row. The converse also holds and is deliberate: an outcomes row
    whose only verdict field is `result` (4 live task ids) is reported as `DISPATCH`, because the row
    itself offers nothing stronger. That is the conservative direction — it understates verification
    rather than overstating it — and such rows should be re-emitted with `outcome` to count.

    Accepted spellings are the ones that actually occur in live data — `verified`, `pass`, `success`,
    boolean `success`, `fail`, `blocked`, `partial`. A row marked `verification_scope: 'run'` is a
    run-level gate result, not a verdict about the `task_id` field, and is excluded from task-level
    verification counts by design.

    Unrecognized spellings are skipped, not guessed: a row whose `result` is `pass_with_residuals`
    falls through to `success`, and if nothing is recognized the answer is `NO_VERIFICATION` — "this
    row makes no verification claim" — never `'failed'`. Absence of evidence must not render as
    failure.
    """
    if row.get('verification_scope') == 'run':
        return NO_VERIFICATION
    attested_event = _ATTESTING_EVENTS.get(row.get('event'))
    if attested_event is not None:
        return VerificationEvidence(attested_event, ATTESTED)
    for key in _VERIFICATION_KEYS:
        if key in row:
            state = _word(row.get(key))
            if state is not None:
                return VerificationEvidence(state, ATTESTED if key in _ATTESTED_KEYS else DISPATCH)
    return NO_VERIFICATION


def verification_state(row: Mapping[str, Any]) -> str | None:
    """The verdict alone: `'verified' | 'failed' | 'partial' | None`.

    Kept for callers that genuinely do not care how the verdict was evidenced. Anything that counts
    or costs *verified tasks* must use `verification_evidence` / `is_attested_verified` instead,
    because this function cannot distinguish an attested verdict from a dispatch exit code — see
    `verification_evidence` for the 18-vs-164 split that distinction exists to preserve.
    """
    return verification_evidence(row).state


def is_attested_verified(row: Mapping[str, Any]) -> bool:
    """Does this row *attest* that the task verified? The gate for every "verified" count and cost."""
    return verification_evidence(row) == VerificationEvidence(VERIFIED, ATTESTED)


def is_dispatch_pass(row: Mapping[str, Any]) -> bool:
    """Did this row's dispatch exit successfully, on dispatch-level evidence only?

    Deliberately excludes attested rows so the two populations are reported separately rather than
    one silently absorbing the other. Use for "dispatch passes", never for "verified tasks".
    """
    return verification_evidence(row) == VerificationEvidence(VERIFIED, DISPATCH)


#: Conservative tie-break order for contradictory verdicts *within* one evidence strength: the
#: earliest entry wins. `FAILED` outranks `PARTIAL` outranks `VERIFIED` because the failure mode this
#: module exists to eliminate is an *over*-count of verified tasks. See `resolve_task_verification`.
_CONSERVATIVE_ORDER = (FAILED, PARTIAL, VERIFIED)
_CONSERVATIVE_RANK = {state: rank for rank, state in enumerate(_CONSERVATIVE_ORDER)}


def resolve_task_verification(rows: Iterable[Mapping[str, Any]]) -> VerificationEvidence:
    """One verdict for one task, from every row that mentions it. Ties break toward *not verified*.

    Per-row `verification_evidence` is not enough for a task-level question, because a task's rows
    can contradict each other and a reader that scans for "any verified row" silently resolves every
    contradiction in favour of success. That is not hypothetical: a QA dispatch that exits 0 while
    reporting failed checks produced an attested `task_verified` metrics row *and* an
    `outcome: 'fail'` outcomes row for the same `task_id`, and the scan counted it as VERIFIED — the
    single strongest number on the dashboard, wrong in the direction that flatters the run.

    So resolution is explicit, and conservative:

    * **Strength first.** `ATTESTED` evidence decides whenever any exists; `DISPATCH` evidence only
      answers when nothing attests. An exit code never overrides a stated verdict — otherwise every
      task with one failed attempt and a later attested pass would read as failed, and retries would
      zero the metric out.
    * **Within a strength, failure wins** (`_CONSERVATIVE_ORDER`). Given an attested verified and an
      attested failed/partial for the same task, the answer is failed/partial. The asymmetry is
      deliberate: this branch exists because `Verified tasks` read 174 when 22 tasks had a real
      verdict, so an over-count is the expensive error and a tie must break away from it. The
      understated direction is also the recoverable one — a task wrongly excluded shows up as
      missing evidence to re-emit, while one wrongly included is invisible.
    * **Absence stays absence.** No rows, or no row making a recognized claim, is `NO_VERIFICATION`,
      never `FAILED`. "Nothing measured this" and "this failed" are different claims, and rendering
      the first as the second is the same class of fabrication in the other direction.

    Returns the resolved `VerificationEvidence`; a task is verified for reporting purposes exactly
    when that is `VerificationEvidence(VERIFIED, ATTESTED)` — see `is_task_attested_verified`.
    Accepts any iterable of the task's rows, from either stream, in any order: resolution is
    order-independent by construction so two readers cannot disagree because of row order.
    """
    strongest: dict[str, str] = {}
    for row in rows:
        state, strength = verification_evidence(row)
        if state is None or strength is None:
            continue
        held = strongest.get(strength)
        if held is None or _CONSERVATIVE_RANK[state] < _CONSERVATIVE_RANK[held]:
            strongest[strength] = state
    # EVIDENCE_STRENGTHS is ordered strongest-first, so the first hit is the deciding class.
    for strength in EVIDENCE_STRENGTHS:
        state = strongest.get(strength)
        if state is not None:
            return VerificationEvidence(state, strength)
    return NO_VERIFICATION


def is_task_attested_verified(rows: Iterable[Mapping[str, Any]]) -> bool:
    """Does this task's *whole* evidence set attest that it verified? The gate for verified counts.

    The task-level counterpart of `is_attested_verified`, which answers only for a single row and so
    cannot see a contradicting verdict elsewhere in the same task. Prefer this wherever tasks are
    counted or costed, and pass every row carrying the `task_id` from both streams.
    """
    return resolve_task_verification(rows) == VerificationEvidence(VERIFIED, ATTESTED)


# --- the missing-data sentinel ---------------------------------------------------------------

class _NoData:
    """Type of `NO_DATA`. Private so `NO_DATA` stays a singleton; test with `is` or `==`."""

    __slots__ = ()
    _instance: '_NoData | None' = None

    def __new__(cls) -> '_NoData':
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __bool__(self) -> bool:
        return False

    def __repr__(self) -> str:
        return 'NO_DATA'

    def __eq__(self, other: object) -> bool:
        return other is self

    def __ne__(self, other: object) -> bool:
        return other is not self

    def __hash__(self) -> int:
        return hash('orchestrator.records.NO_DATA')

    def __reduce__(self):
        # Keep the singleton identity across pickle/copy so `is NO_DATA` never silently fails.
        return (_no_data, ())


def _no_data() -> '_NoData':
    return NO_DATA


#: "No measurement exists", as distinct from a measured zero.
#:
#: Falsy so `if value:` guards keep working, but never equal to `0`, `0.0`, `False`, `''` or `None`,
#: so a renderer can branch on it and print `—` (or `not instrumented`) instead of `0`. Six dashboard
#: cards rendered `0` for fields with no producer anywhere; that is the bug this sentinel closes.
NO_DATA = _NoData()


def is_no_data(value: Any) -> bool:
    """Identity test for the sentinel. Prefer this to `value == NO_DATA` in hot paths."""
    return value is NO_DATA


def json_default(value: Any) -> Any:
    """`json.dumps(..., default=json_default)` hook: serialize `NO_DATA` as `null`.

    JSON has no third state, so the wire form is `null` and the *renderer* decides between `—` and
    `not instrumented` using `INSTRUMENTED_FIELDS`. Anything else raises `TypeError`, matching what
    `json` expects of a `default` hook so genuinely unserializable values are still reported.
    """
    if value is NO_DATA:
        return None
    raise TypeError(f'Object of type {type(value).__name__} is not JSON serializable')


def to_json(value: Any) -> Any:
    """Recursively replace `NO_DATA` with `None` in nested dicts/lists/tuples/sets.

    `dashboard.build_data` returns one nested structure that is embedded into HTML via `json.dumps`;
    a `default=` hook only fires for values `json` cannot handle, which is enough here but not for
    callers that need a plain-Python payload (tests, `scripts/`). Both paths are provided so nobody
    invents a third.
    """
    if value is NO_DATA:
        return None
    if isinstance(value, dict):
        return {key: to_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_json(item) for item in value]
    if isinstance(value, (set, frozenset)):
        return [to_json(item) for item in value]
    return value


def ratio(numerator: Any, denominator: Any) -> Any:
    """`numerator / denominator`, or `NO_DATA` when the denominator gives no basis for a ratio.

    Every fabricated rate on the dashboard came from `x/y if y else 0` or from flooring the
    denominator (`max(1e-9, p50)`, which is how a $0 p50 became a billion-fold tail ratio). A ratio
    with an empty denominator is unknown, not zero — and never a division by an epsilon.
    """
    if numerator is NO_DATA or denominator is NO_DATA:
        return NO_DATA
    if denominator is None:
        return NO_DATA
    basis = _number(denominator)
    if basis == 0:
        return NO_DATA
    return _number(numerator) / basis


def metric(value: Any, samples: Any) -> Any:
    """Return `value` when it rests on at least one sample, else `NO_DATA`.

    Wrap any aggregate whose inputs may be empty (`quantile([])`, `mean([])`, a count over rows that
    do not exist). `samples` is the size of the population the value was computed from, so a caller
    cannot forget to state it. A `None` value is also `NO_DATA`: "computed nothing" is the same claim
    as "had nothing to compute from", and collapsing both means consumers handle one missing form.
    """
    if samples is NO_DATA or samples is None:
        return NO_DATA
    if int(_number(samples)) <= 0:
        return NO_DATA
    return NO_DATA if value is None else value


# --- instrumentation registry ----------------------------------------------------------------

#: Metric fields with a real producer in this repository, mapped to that producer. Verified by
#: grepping `orchestrator/`, `bridge/`, `scripts/` and `adapters/` for writes, not reads.
#:
#: Instrumented does NOT mean every row carries the field: `quality_evidence_score` is written only
#: by `Engine.verify_task`, which no live run has called, and `retry`/`waste_reason` appear on 12 and
#: 13 live rows respectively. It means an absent value is plausibly a real absence and a zero is
#: plausibly a real zero — so the dashboard may render `0`/`—` rather than `not instrumented`.
INSTRUMENTED_FIELDS: Mapping[str, str] = {
    'cost_usd': 'runtime.EventStore.metric (reported or priced via pricing.estimate_cost_usd); ingest.ingest_file',
    'input_tokens': 'ingest.read_humain_terminal / ingest.read_codex',
    'output_tokens': 'ingest.read_humain_terminal / ingest.read_codex',
    'retry': 'agent-authored metric rows via cli.py `metric` (12 live rows)',
    'waste_reason': 'agent-authored metric rows via cli.py `metric` (13 live rows)',
    'quality_evidence_score': 'engine.Engine.verify_task only — never emitted by a live run',
    'covers_calls': 'ingest.ingest_file when granularity == SESSION',
    'executed_cost_usd': 'bridge/extensions/orchestrator/index.ts route_executed',
}

#: Fields and event names the dashboard reads but nothing in this repo writes. Rendering these as
#: `0` invents a measurement; they must render as `not instrumented`. Per the plan's non-goals, do
#: not invent producers for them — either instrument them honestly or keep saying so.
UNINSTRUMENTED_FIELDS: Mapping[str, str] = {
    'review_wait_ms': 'read by dashboard.build_data; no emitter — the dispatch queue never records the wait',
    'context_packet': 'read by dashboard.build_data as the miss-rate denominator; no emitter',
    'context_packet_miss': 'read by dashboard.build_data; no emitter',
    'context_refetch': 'read by dashboard.build_data; no emitter',
    'decision_invalidated': 'read by economics.fanout_rework; state.py only reduces it, nothing emits it',
    'shadow_review': 'read by dashboard.build_data; runtime.py models shadow review in simulation only',
    'verification_result': 'read by verification.flaky_stats (requires check_id); no emitter',
}


def is_instrumented(field: str) -> bool:
    """Does `field` (a metric key or event name) have a producer in this repository?

    Conservative by construction: only the registry above answers `True`. An unlisted field is
    reported as uninstrumented because the alternative — assuming a producer exists — is exactly
    how six cards came to render `0` for signals nobody ever wrote. Adding a field here is a claim
    that must be backed by a write site, and `UNINSTRUMENTED_FIELDS` records the known negatives so
    a reviewer can tell "checked, absent" from "never considered".
    """
    return field in INSTRUMENTED_FIELDS

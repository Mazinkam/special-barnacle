"""Reconciling session-ID drift by exact source call coverage, never by token totals.

Split out of `orchestrator/ingest.py` (B3, `docs/architecture-review.md`).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from ..runtime import stable_hash
from .checkpoint import add_totals, empty_totals, totals_equal
from .ledger import IngestLedger
from .parsers import HUMAIN_TERMINAL


class SourceConflict(ValueError):
    """The log and metrics.jsonl disagree in a way no checkpoint can reconstruct; nothing was written."""


def call_id_for(runtime: str, session_id: str, native_id: str) -> str:
    return stable_hash(['model_call', runtime, session_id, native_id])


def _reconcile_source_calls(calls: list[dict[str, Any]], *, runtime: str, path: Path,
                            live: set[str], history: dict[tuple[str, str], dict[str, Any]],
                            ledger: IngestLedger, resumable: bool, promotions: dict[str, dict[str, Any]],
                            source_identity: list[int], checkpoint_identity: list[int] | None,
                            alias_targets: dict[str, set[str]] | None = None
                            ) -> tuple[set[str], dict[str, set[str]]]:
    """Resolve orphaned session IDs by exact source call coverage, never by token totals.

    The current native ID can recreate its old session-qualified hash. A matching hash in
    this source's authoritative coverage (or its observed history) identifies the same call.
    Preserve that hash in observations, so drift does not invent unpaid historical aliases
    when metrics are later rolled back. Multiple old identities and positional IDs are not
    evidence of a unique call and must not silently suppress usage. For a rewrite, require
    complete matching coverage and per-model usage as well: reused IDs with missing or changed
    calls are ambiguous. Totals validate an identity match; they never pay for unmatched IDs.
    """
    if not calls:
        return set(), {}  # no identity to reconcile; keep seeded Codex ledgers incremental
    if not resumable:
        # Live IDs bypass alias reconciliation below, but their paid hashes are not
        # proof of continuity across an inode replacement for fallback identities,
        # whether still headerless or promoted to explicit IDs. Check provenance
        # BEFORE comparing any paid IDs, including same-session IDs.
        # Explicit-only sessions still support rotation with call-ID deduplication.
        source_states = ledger.source_states(runtime, path)
        current_generation = {tuple(source_identity)}
        fallback_sessions = {str(call['session_id']) for call in calls if call.get('session_origin') == 'fallback'}
        for sid in {str(call['session_id']) for call in calls}:
            state = source_states.get(sid)
            if not state:
                continue  # no target coverage to inherit; a rotated target can be billed in full
            fallback_origin = sid in fallback_sessions or 'fallback' in state.get('session_origins', set())
            rotated_target = any(bound['to_session_id'] == sid and bound['source_identity'] != source_identity
                                 for bound in promotions.values())
            if ((fallback_origin or rotated_target)
                    and state.get('source_identities', set()) != current_generation):
                # A binding can predate a fully billed replacement. Only rows wholly
                # from that replacement permit its retries; mixed/missing generations
                # cannot establish which same-session calls were actually paid.
                raise SourceConflict(f'{path}: session {sid}: ambiguous source generation for a live fallback or promoted identity; '
                                     'reconcile source identities before retrying; nothing was written.')
    # Missing/old checkpoints are not permission to alias explicit logical sessions.
    # Rebuild eligibility from source-scoped authoritative rows. Unknown legacy origins
    # remain candidates only so an overlapping identity is rejected, never guessed paid/new.
    unknown_origins: set[str] = set()
    if alias_targets is None:
        source_states = ledger.source_states(runtime, path)
        fallback = set()
        explicit_history = any('explicit' in state.get('session_origins', set()) for state in source_states.values())
        for sid in (set(source_states) | {sid for sid, _ in history}) - live:
            origins = source_states.get(sid, {}).get('session_origins', set())
            if origins == {'fallback'}:
                fallback.add(sid)
                if sid not in promotions and (explicit_history or source_states[sid].get('legacy_promotions')):
                    # An older writer may already have consumed this fallback in a
                    # promotion, even one with zero new metrics. Without a protocol
                    # marker or binding, origins cannot name its target; do not guess.
                    unknown_origins.add(sid)
            elif origins != {'explicit'}:
                unknown_origins.add(sid)
        alias_targets = {sid: set(unknown_origins) for sid in live}
        for call in calls:
            if call.get('session_origin') == 'explicit':
                alias_targets[str(call['session_id'])].update(fallback)
    # Durable bindings constrain even a stale checkpoint's proposed aliases. A paid
    # fallback can belong to only one explicit logical session, never its successor.
    for target, ids in alias_targets.items():
        ids.difference_update(sid for sid, bound in promotions.items() if bound['to_session_id'] != target)
        ids.update(sid for sid, bound in promotions.items() if bound['to_session_id'] == target and sid not in live)
    unknown_origins.difference_update(promotions)
    eligible = {sid for ids in alias_targets.values() for sid in ids}
    unknown_generations: set[str] = set()
    for sid in eligible:
        binding = promotions.get(sid)
        if binding is not None and binding['source_identity'] != source_identity:
            same_generation = False
        elif checkpoint_identity is not None and any(old_sid == sid for old_sid, _ in history):
            same_generation = checkpoint_identity == source_identity
        else:
            # Native IDs and equal usage can recur at the same path on a new inode.
            # All source-scoped rows must establish continuity; missing/mixed legacy
            # generations cannot be filled in from a different row or a binding.
            generations = ledger.source_states(runtime, path).get(sid, {}).get('source_identities', set())
            current = tuple(source_identity)
            same_generation = generations == {current}
            if not same_generation and (not generations or None in generations or current in generations):
                unknown_generations.add(sid)
                continue
        if not same_generation:
            for ids in alias_targets.values():
                ids.discard(sid)
    eligible = {sid for ids in alias_targets.values() for sid in ids}
    candidates: dict[str, set[str]] = {}
    evidence = []
    if not resumable:
        for sid, state in ledger.source_states(runtime, path).items():
            if sid in live or sid not in eligible:
                continue
            if state['unidentified']:
                raise SourceConflict(f'{path}: session {sid}: ambiguous totals-only source history after session ID '
                                     'drift; reconcile the legacy rows with call IDs before retrying; nothing was written.')
            candidates[sid] = set(state['covered_call_ids'])
            evidence.append((sid, set(state['covered_call_ids']), state['models']))
    for (sid, model), group in history.items():
        if sid not in live and sid in eligible:
            candidates.setdefault(sid, set()).update(group['call_ids'])
            if not resumable:
                evidence.append((sid, set(group['call_ids']), {model: group}))
    paid = set()
    aliases: dict[str, set[str]] = {}
    matched: dict[str, dict[str, dict[str, Any]]] = {}
    for call in calls:
        target = str(call['session_id'])
        matches = {sid: call_id_for(runtime, sid, call['native_id']) for sid, ids in candidates.items()
                   if sid in alias_targets.get(target, set())
                   and call_id_for(runtime, sid, call['native_id']) in ids}
        if not matches:
            continue
        if unknown_origins.intersection(matches):
            raise SourceConflict(f'{path}: ambiguous session provenance in source history after session ID drift; '
                                 'restore provenance or reconcile the legacy rows before retrying; nothing was written.')
        if unknown_generations.intersection(matches):
            raise SourceConflict(f'{path}: ambiguous source generation after session ID drift; restore a matching '
                                 'checkpoint or reconcile metric source identities before retrying; nothing was written.')
        # Historical hashes do not distinguish HT's numeric positional fallback from an
        # explicit numeric ID. Neither can safely establish cross-session identity.
        positional = runtime == HUMAIN_TERMINAL and call['native_id'].isdecimal()
        if len(matches) != 1 or positional or not call.get('_native_id_stable', False):
            raise SourceConflict(f'{path}: ambiguous source-native call identity after session ID drift; '
                                 'restore unambiguous source history before retrying; nothing was written.')
        sid, call_id = next(iter(matches.items()))
        if any(sid in ids and other != target for other, ids in aliases.items()):
            raise SourceConflict(f'{path}: ambiguous session promotion to multiple explicit sessions; nothing was written.')
        # Retain the original session-qualified identity for old calls only. New calls keep
        # the session the reader found; no tokens move between recorded session buckets.
        call['session_id'] = sid
        call['session_origin'] = 'fallback'
        aliases.setdefault(target, set()).add(sid)
        matched.setdefault(sid, {})[call_id] = call
        if call_id in ledger.state(runtime, sid)['covered_call_ids']:
            paid.add(call_id)
    for sid, ids, models in evidence:
        found = matched.get(sid, {})
        if not ids.intersection(found):
            continue
        totals: dict[str, dict[str, int]] = {}
        for call_id in ids.intersection(found):
            call = found[call_id]
            add_totals(totals.setdefault(str(call.get('model') or ''), empty_totals()), call)
        if not ids.issubset(found) or any(not totals_equal(models.get(model), totals.get(model))
                                        for model in set(models) | set(totals)):
            raise SourceConflict(f'{path}: session {sid}: ambiguous source-native coverage after session ID drift; '
                                 'missing calls or changed usage cannot establish identity; nothing was written.')
    return paid, aliases

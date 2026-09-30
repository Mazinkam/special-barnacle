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

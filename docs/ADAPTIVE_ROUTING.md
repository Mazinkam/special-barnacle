# Adaptive Routing in V3

Adaptive routing chooses a **compute package**, not merely a model.

A package contains:

- capability class
- effort level
- context budget
- verification depth
- reviewer-independence requirement

The routing objective is the lowest estimated verified cost that satisfies the effective quality floor, subject to risk and feature constraints.

## Evidence

Historical comparisons are grouped by:

- task class
- complexity bucket
- risk
- capability
- effort
- verification depth
- topology shape when available

Delayed outcomes can reduce confidence in routes that look good at completion but later cause regressions, rollbacks, reopens, or human corrections.

## Rollout

Recommended rollout:

1. `observe`
2. `recommend`
3. `enforce` for low/medium-risk classes with sufficient data
4. expand scope only after delayed outcomes mature

Do not enable automatic policy tuning simply because adaptive routing is trusted. Adaptive routing chooses within an approved policy; policy tuning changes the policy itself.

## Exploration

Without controlled exploration, the system can become self-confirming: a route never tried on harder tasks can never accumulate evidence. Exploration therefore exists, but should be bounded by:

- sample rate
- risk exclusion
- maximum incremental estimated cost
- explicit telemetry

## Reproducibility

Canary assignment is deterministic. Normal exploration is also seeded deterministically by run/task identity in the reference scaffold so the same plan can be explained and replayed. A harness may choose stronger reproducibility guarantees when `reproducible_routing.enabled` is true.

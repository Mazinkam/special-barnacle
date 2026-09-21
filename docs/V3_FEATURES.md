# V3 Feature Controls

V3 separates mechanisms from policy and makes behavior that can materially change cost, autonomy, verification, or repository state independently configurable.

## Common state types

- Boolean: `enabled: true|false`
- Adaptive state: `off | on | adaptive`
- Learning/autonomy mode: `off | observe | recommend | enforce`
- Review mode: `off | sampled | risk_based | always`
- Approval mode: `deny | ask | allow`
- Budget mode: `monitor | warn | enforce`

## Inheritance

Feature configuration is resolved in this order:

```text
global config
  -> repository overrides
      -> task overrides
```

Hard safety/correctness constraints should not be weakened by lower-scope overrides unless your integration explicitly permits it.

## Adaptive routing

Default: `recommend`.

- `off`: deterministic configured defaults only.
- `observe`: compute the empirical route and record it, but execute the deterministic default.
- `recommend`: expose the route recommendation and evidence, but execute the deterministic default.
- `enforce`: execute the empirical route when minimum evidence thresholds are met; otherwise fall back safely.

Sub-switches independently control whether empirical routing can change model capability, effort, topology, context budget, or verification depth.

## Learning safeguards

- Historical learning has a minimum sample threshold.
- Controlled exploration is low-rate and excludes high-risk work by default.
- Shadow routing can estimate an alternative without executing it.
- Policy simulation uses observed historical cohorts and is explicitly labeled estimated.
- Canary assignment is deterministic by run ID.
- Automatic policy tuning and promotion are off by default.

## Repository mutation safeguards

- Auto merge: off by default.
- Auto deploy: off by default.
- Destructive operations: deny by default.
- Dependency add/upgrade: ask by default.

## Explainability

When enabled, each routing decision records:

- static default package
- empirical recommendation
- selected package
- evidence/sample count
- effective quality floor
- cost aggressiveness
- whether exploration occurred
- whether shadow routing was selected
- topology source

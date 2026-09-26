"""`route`/`plan`/`topology`/`simulate-policy`/`recommend-policy`/`features`/`resolve-adapter`: the
routing/engine-facing commands (B3, `docs/architecture-review.md`). See `records_cmds.py`'s module
docstring for why every handler resolves cli-level helpers through `from orchestrator import cli`
inside the function body instead of importing them at module scope.
"""
from __future__ import annotations

import json


def register(sp) -> None:
    from orchestrator import cli

    sp.add_parser('features', help='resolve and print the effective feature inventory from config.json (repo/task overrides not applied here)')
    sp.add_parser('recommend-policy', help='recommend a quality-floor/cost-aggressiveness policy from recorded route history')
    r = sp.add_parser('route', help='resolve a route (capability/effort/policy) for one task without recording a plan_run')
    r.add_argument('task_class', help="task classification, e.g. 'coding'")
    r.add_argument('complexity', type=float, help='estimated complexity, 0-10')
    r.add_argument('risk', help='risk tier: low, medium, high, or critical')
    r.add_argument('--run-id', default='cli-route', help="run id to attribute the route to (default: 'cli-route')")
    cli._add_policy_override_flags(r)
    p = sp.add_parser('plan', help='resolve a full route and record a plan_run event for the given run id')
    p.add_argument('run_id', help='run id to record the plan under')
    p.add_argument('task_class', help="task classification, e.g. 'coding'")
    p.add_argument('complexity', type=float, help='estimated complexity, 0-10')
    p.add_argument('risk', help='risk tier: low, medium, high, or critical')
    p.add_argument('--coupling', type=float, default=.5, help='estimated coupling, 0-1 (default: 0.5)')
    p.add_argument('--parallelizable', type=float, default=.5, help='estimated parallelizable fraction, 0-1 (default: 0.5)')
    p.add_argument('--repo-revision', help='repo revision to attach to the plan, used for context-cache invalidation')
    cli._add_policy_override_flags(p)
    sim = sp.add_parser('simulate-policy', help='simulate a candidate quality-floor/cost-aggressiveness policy against recorded history without recording anything')
    sim.add_argument('--quality-floor', type=float, required=True, help='candidate quality floor, 0-1')
    sim.add_argument('--cost-aggressiveness', type=float, required=True, help='candidate cost aggressiveness, 0-1')
    t = sp.add_parser('topology', help='recommend a topology (shape/depth/workers) for the given complexity, without recording anything')
    t.add_argument('complexity', type=float, help='estimated complexity, 0-10')
    t.add_argument('--coupling', type=float, default=.5, help='estimated coupling, 0-1 (default: 0.5)')
    t.add_argument('--parallelizable', type=float, default=.5, help='estimated parallelizable fraction, 0-1 (default: 0.5)')
    t.add_argument('--risk', default='medium', help='risk tier: low, medium, high, or critical (default: medium)')
    ra = sp.add_parser('resolve-adapter', help='resolve the capability -> provider/model adapter table')
    ra.add_argument('--json', action='store_true', help='emit JSON')
    ra.add_argument('--explain', action='store_true', help='include selection reasoning')
    ra.add_argument('--model-family', default=None, help="override model-family preference (default: anthropic via CODING_AGENT_ORCHESTRATOR_MODEL_FAMILY; pass 'none'/'cost' to disable)")


def _policy_overrides(args) -> dict:
    overrides = {}
    if args.quality_floor is not None:
        overrides['quality_floor'] = args.quality_floor
    if args.cost_aggressiveness is not None:
        overrides['cost_aggressiveness'] = args.cost_aggressiveness
    return overrides


def handle_features(args, root, C) -> None:
    from orchestrator import cli
    f = cli.FeaturePolicy(C.get('features', {})).resolve()
    print(json.dumps(cli.feature_inventory(f), indent=2))


def handle_recommend_policy(args, root, C) -> None:
    from orchestrator import cli
    print(json.dumps(cli.eng(root).recommend_policy(), indent=2))


def handle_route(args, root, C) -> None:
    from orchestrator import cli
    plan = cli.eng(root).plan_run(run_id=args.run_id, task_class=args.task_class, complexity=args.complexity,
                                   risk=args.risk, user_overrides=_policy_overrides(args))
    print(json.dumps(plan['route'], indent=2))


def handle_plan(args, root, C) -> None:
    from orchestrator import cli
    print(json.dumps(cli.eng(root).plan_run(
        run_id=args.run_id, task_class=args.task_class, complexity=args.complexity, risk=args.risk,
        coupling=args.coupling, parallelizable=args.parallelizable, repo_revision=args.repo_revision,
        user_overrides=_policy_overrides(args)), indent=2))


def handle_simulate_policy(args, root, C) -> None:
    from orchestrator import cli
    print(json.dumps(cli.eng(root).simulate_policy(
        candidate_quality_floor=args.quality_floor, candidate_cost_aggressiveness=args.cost_aggressiveness), indent=2))


def handle_topology(args, root, C) -> None:
    from orchestrator import cli
    print(json.dumps(cli.topology_for(args.complexity, args.coupling, args.parallelizable, args.risk), indent=2))


def handle_resolve_adapter(args, root, C) -> None:
    from orchestrator import cli
    a = cli.resolve_adapter(model_family=args.model_family)
    # --json and --explain are aliases: both emit machine-readable JSON.
    # The table form is the default when neither is set for human reading.
    if args.json or args.explain:
        print(json.dumps(a, indent=2))
    else:
        # Default: print a compact capability -> provider/model table.
        print(cli._format_adapter_table(a))


HANDLERS = {
    'features': handle_features,
    'recommend-policy': handle_recommend_policy,
    'route': handle_route,
    'plan': handle_plan,
    'simulate-policy': handle_simulate_policy,
    'topology': handle_topology,
    'resolve-adapter': handle_resolve_adapter,
}

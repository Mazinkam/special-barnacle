"""B3 review requirement (`docs/architecture-review.md`): a table of representative argv for every
subcommand (including every argv the bridge actually sends `python3 -m orchestrator.cli`), checked
against the real `build_parser()`. `test_cli_args.py` already extracts the bridge's literal argv
for `plan`/`ingest` dynamically from `index.ts`/`ingest.ts`; this file pins down the *values* those
and every other subcommand parse to, as `Namespace` dicts, so a change to a default, a `type=`
coercion, `nargs`, or required-ness on any subparser (in `records_cmds.py`, `routing_cmds.py`,
`ingest_cmds.py`, `context_cmds.py`, `archive_cmds.py`, or here) is caught immediately.

Every expected dict below was captured by running the pre-split parser (`orchestrator/cli.py` at
commit `580c504`, `build_parser().parse_args(argv)`) on the same argv and dumping `vars(args)`.
"""
from __future__ import annotations

import pytest

from orchestrator.archive import DEFAULT_OLDER_THAN_DAYS
from orchestrator.cli import build_parser

#: (argv, expected `vars(Namespace)`). Every entry the bridge sends verbatim is annotated with
#: where it comes from.
CASES: list[tuple[list[str], dict]] = [
    # `bridge/extensions/orchestrator/record-queue.ts` / `index.ts` (`dispatchRecordsFor`): every
    # durable write the bridge makes goes through `batch -`.
    (['batch', '-'], {'cmd': 'batch', 'payload': '-'}),
    (['batch'], {'cmd': 'batch', 'payload': None}),
    (['init'], {'cmd': 'init'}),
    (['status'], {'cmd': 'status'}),
    (['dashboard'], {'cmd': 'dashboard'}),
    (['rebuild'], {'cmd': 'rebuild'}),
    (['features'], {'cmd': 'features'}),
    (['recommend-policy'], {'cmd': 'recommend-policy'}),
    (['event', 'run_started'], {'cmd': 'event', 'event': 'run_started', 'payload': '{}'}),
    (['event', 'run_started', '{"run_id":"r1"}'],
     {'cmd': 'event', 'event': 'run_started', 'payload': '{"run_id":"r1"}'}),
    (['metric', '{}'], {'cmd': 'metric', 'payload': '{}'}),
    (['outcome', '{}'], {'cmd': 'outcome', 'payload': '{}'}),
    (['quality', '{}'], {'cmd': 'quality', 'payload': '{}'}),
    (['route', 'coding', '0.6', 'medium'],
     {'cmd': 'route', 'task_class': 'coding', 'complexity': 0.6, 'risk': 'medium',
      'run_id': 'cli-route', 'quality_floor': None, 'cost_aggressiveness': None}),
    # `bridge/extensions/orchestrator/index.ts` `planRun`: exact literal argv shape (positionals +
    # `--coupling`/`--parallelizable` always, `--quality-floor`/`--cost-aggressiveness` when set).
    (['plan', 'run-1', 'coding', '0.6', 'medium', '--coupling', '0.5', '--parallelizable', '0.5',
      '--quality-floor', '0.9', '--cost-aggressiveness', '0.5'],
     {'cmd': 'plan', 'run_id': 'run-1', 'task_class': 'coding', 'complexity': 0.6, 'risk': 'medium',
      'coupling': 0.5, 'parallelizable': 0.5, 'repo_revision': None,
      'quality_floor': 0.9, 'cost_aggressiveness': 0.5}),
    (['plan', 'run-1', 'coding', '0.6', 'medium'],
     {'cmd': 'plan', 'run_id': 'run-1', 'task_class': 'coding', 'complexity': 0.6, 'risk': 'medium',
      'coupling': 0.5, 'parallelizable': 0.5, 'repo_revision': None,
      'quality_floor': None, 'cost_aggressiveness': None}),
    (['simulate-policy', '--quality-floor', '0.9', '--cost-aggressiveness', '0.5'],
     {'cmd': 'simulate-policy', 'quality_floor': 0.9, 'cost_aggressiveness': 0.5}),
    (['topology', '5'],
     {'cmd': 'topology', 'complexity': 5.0, 'coupling': 0.5, 'parallelizable': 0.5, 'risk': 'medium'}),
    # `bridge/extensions/orchestrator/index.ts:570`: `resolve-adapter --explain`.
    (['resolve-adapter', '--explain'],
     {'cmd': 'resolve-adapter', 'json': False, 'explain': True, 'model_family': None}),
    (['resolve-adapter'], {'cmd': 'resolve-adapter', 'json': False, 'explain': False, 'model_family': None}),
    # `bridge/extensions/orchestrator/ingest.ts` `ingestArgs`: exact literal argv the session-ingest
    # hook and the launchd sweep send.
    (['ingest', '/s/a.jsonl', '--runtime', 'humain-terminal', '--granularity', 'session', '--quiet'],
     {'cmd': 'ingest', 'paths': ['/s/a.jsonl'], 'runtime': 'humain-terminal', 'repository': None,
      'dry_run': False, 'granularity': 'session', 'discover': False, 'since_days': None,
      'limit': None, 'quiet': True, 'include_scratch': False}),
    (['ingest'],
     {'cmd': 'ingest', 'paths': [], 'runtime': None, 'repository': None, 'dry_run': False,
      'granularity': 'call', 'discover': False, 'since_days': None, 'limit': None, 'quiet': False,
      'include_scratch': False}),
    (['context-put', 'c1', 'hello', '--source', 'run-1'],
     {'cmd': 'context-put', 'id': 'c1', 'content': 'hello', 'source': 'run-1',
      'status': 'observed', 'revision': None}),
    (['context-packet', 'c1,c2'], {'cmd': 'context-packet', 'ids': 'c1,c2', 'budget': 18000}),
    # `bridge/extensions/orchestrator/index.ts:231`: `restore-run <run_id>`.
    (['archive-runs'],
     {'cmd': 'archive-runs', 'older_than_days': DEFAULT_OLDER_THAN_DAYS, 'execute': False, 'json': False}),
    (['archive-runs', '--execute', '--json'],
     {'cmd': 'archive-runs', 'older_than_days': DEFAULT_OLDER_THAN_DAYS, 'execute': True, 'json': True}),
    (['restore-run', 'run-1'],
     {'cmd': 'restore-run', 'run_id': 'run-1', 'dry_run': False, 'json': False}),
]


@pytest.mark.parametrize('argv,expected', CASES, ids=[' '.join(c[0]) or '(empty)' for c in CASES])
def test_representative_argv_matches_the_pre_split_parser(argv, expected):
    args = build_parser().parse_args(argv)
    assert vars(args) == expected


def test_every_subcommand_has_at_least_one_case():
    covered = {argv[0] for argv, _ in CASES if argv}
    parser = build_parser()
    subparsers_action = next(a for a in parser._subparsers._group_actions if hasattr(a, 'choices'))
    assert covered == set(subparsers_action.choices)

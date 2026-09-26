"""`init`/`event`/`metric`/`outcome`/`batch`/`quality`/`status`/`rebuild`/`dashboard`: the durable-write
and read-back commands (B3, `docs/architecture-review.md`).

Every handler resolves the cli-level helpers it needs (`cli._write`, `cli._single`, `cli.EXIT_OK`,
...) through `from orchestrator import cli` inside the function body rather than importing them at
module scope, so a test that does `mock.patch.object(cli, 'ROOT', ...)` (or any other attribute on
the `orchestrator.cli` package) is still honoured no matter which module dispatches the command —
see the module docstring on `orchestrator/cli/__init__.py`.
"""
from __future__ import annotations

import json


def register(sp) -> None:
    sp.add_parser('init', help='append the schema-3 orchestrator_initialized event and refresh the ledger/dashboard')
    sp.add_parser('status', help='print the current ledger (rebuilding it from durable streams first if it is missing/stale)')
    sp.add_parser('dashboard', help='render and print the dashboard HTML for the current state root')
    sp.add_parser('rebuild', help='replay every durable stream from byte 0 (discarding the record-id cache) and republish the ledger/dashboard')
    e = sp.add_parser('event', help='append one event record and refresh the ledger/dashboard once')
    e.add_argument('event', help="event name, e.g. 'run_started'")
    e.add_argument('payload', nargs='?', default='{}', help="JSON object payload (default: '{}')")
    m = sp.add_parser('metric', help='append one metric record and refresh the ledger/dashboard once')
    m.add_argument('payload', help='JSON object payload')
    o = sp.add_parser('outcome', help='append one outcome record and refresh the ledger/dashboard once')
    o.add_argument('payload', help='JSON object payload')
    b = sp.add_parser('batch', help='append an ordered batch of event/metric/outcome records (JSON array on stdin or as argument) and refresh once')
    b.add_argument('payload', nargs='?', default=None, help="JSON array of {stream, record_id, ...} records, or '-'/omitted to read stdin")
    q = sp.add_parser('quality', help='score a QualityEvidence payload (hard-gate pass/fail and its evidence score) without appending anything')
    q.add_argument('payload', help='JSON object with QualityEvidence fields')


def handle_init(args, root, C) -> None:
    from orchestrator import cli
    code, body = cli._write(root, [cli.single_record('event', {'schema_version': 3}, event='orchestrator_initialized')])
    if code != cli.EXIT_OK:
        print(json.dumps(body))
        raise SystemExit(code)
    print('Initialized V3 state')


def handle_status(args, root, C) -> None:
    from orchestrator import cli
    print(json.dumps(cli.load_or_rebuild(root), indent=2))


def handle_dashboard(args, root, C) -> None:
    from orchestrator import cli
    print(cli.generate_dashboard(root, config=C))


def handle_rebuild(args, root, C) -> None:
    from orchestrator import cli
    print(json.dumps(cli.rebuild(root), indent=2))
    cli.generate_dashboard(root, config=C)


def handle_event(args, root, C) -> None:
    from orchestrator import cli
    raise SystemExit(cli._single('event', args.payload, event=args.event, root=root))


def handle_metric(args, root, C) -> None:
    from orchestrator import cli
    raise SystemExit(cli._single('metric', args.payload, root=root))


def handle_outcome(args, root, C) -> None:
    from orchestrator import cli
    raise SystemExit(cli._single('outcome', args.payload, root=root))


def handle_batch(args, root, C) -> None:
    from orchestrator import cli
    try:
        records = cli._batch_payload(args.payload)
    except cli.BatchValidationError as exc:
        print(json.dumps(cli._failure(cli.STATUS_INVALID, str(exc))))
        raise SystemExit(cli.EXIT_INVALID) from exc
    raise SystemExit(cli.write_records(records, root))


def handle_quality(args, root, C) -> None:
    from orchestrator import cli
    ev = cli.QualityEvidence(**json.loads(args.payload))
    print(json.dumps({'hard_gate_pass': ev.hard_gate_pass(), 'quality_evidence_score': ev.evidence_score()}, indent=2))


HANDLERS = {
    'init': handle_init,
    'status': handle_status,
    'dashboard': handle_dashboard,
    'rebuild': handle_rebuild,
    'event': handle_event,
    'metric': handle_metric,
    'outcome': handle_outcome,
    'batch': handle_batch,
    'quality': handle_quality,
}

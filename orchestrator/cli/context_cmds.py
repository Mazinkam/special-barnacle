"""`context-put`/`context-packet`: the context-registry commands (B3, `docs/architecture-review.md`).
See `records_cmds.py`'s module docstring for why every handler resolves cli-level helpers through
`from orchestrator import cli` inside the function body instead of importing them at module scope.
"""
from __future__ import annotations

import json


def register(sp) -> None:
    c = sp.add_parser('context-put', help='record one piece of context (a discovery, decision, or observation) in the context registry')
    c.add_argument('id', help='context id to store/overwrite')
    c.add_argument('content', help='the context content')
    c.add_argument('--source', required=True, help='where this context came from, e.g. a run id or file path')
    c.add_argument('--status', default='observed', help="context status, e.g. 'observed' (default) or 'verified'")
    c.add_argument('--revision', help='repo revision this context is valid for, used to invalidate stale packets')
    cp = sp.add_parser('context-packet', help='assemble a token-budgeted packet of context entries by id')
    cp.add_argument('ids', help='comma-separated list of context ids to include')
    cp.add_argument('--budget', type=int, default=18000, help='token budget for the packet (default: 18000)')


def handle_context_put(args, root, C) -> None:
    from orchestrator import cli
    print(json.dumps(cli.ContextRegistry(root).put(
        args.id, args.content, source=args.source, status=args.status, repo_revision=args.revision), indent=2))


def handle_context_packet(args, root, C) -> None:
    from orchestrator import cli
    ids = [x.strip() for x in args.ids.split(',') if x.strip()]
    print(json.dumps(cli.ContextRegistry(root).packet(ids, args.budget), indent=2))


HANDLERS = {
    'context-put': handle_context_put,
    'context-packet': handle_context_packet,
}

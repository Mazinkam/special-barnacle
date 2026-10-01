"""Cost of a plain humain-terminal agent run, from its `--mode json` event stream (spec §1.2).

The orchestrated arms record cost through the orchestrator's telemetry; the direct arm has none, so its cost
used to read as $0 / incomplete. Cost = the agent's own turns (`message_end` assistant `usage.cost.total`)
plus its `subagent` tool children (`details.results[].usage.cost`; updates are cumulative snapshots, so the
latest per child wins). Like the bridge's nested accounting, each level reports its own cost only. Any turn
or child without a numeric cost makes the total incomplete; a missing cost is never treated as zero.
"""
from __future__ import annotations

import json
from pathlib import Path


def _number(value) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 else None


def agent_stream_cost(path: Path) -> tuple[float | None, bool]:
    """(known cost, complete). (None, False) when the stream has no assistant turn at all."""
    try:
        lines = Path(path).read_text(encoding='utf-8', errors='replace').splitlines()
    except OSError:
        return None, False
    own, turns, complete = 0.0, 0, True
    nested: dict[tuple, float | None] = {}
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if not isinstance(e, dict):
            continue
        kind = e.get('type')
        if kind == 'message_end':
            msg = e.get('message') or {}
            if isinstance(msg, dict) and msg.get('role') == 'assistant':
                turns += 1
                cost = _number(((msg.get('usage') or {}).get('cost') or {}).get('total'))
                if cost is None:
                    complete = False
                else:
                    own += cost
        elif kind in ('tool_execution_update', 'tool_execution_end') and e.get('toolName') == 'subagent':
            body = e.get('partialResult') if kind == 'tool_execution_update' else e.get('result')
            results = ((body or {}).get('details') or {}).get('results') if isinstance(body, dict) else None
            for i, r in enumerate(results or []):
                if isinstance(r, dict):
                    key = (e.get('toolCallId'), r.get('taskId') or i)
                    nested[key] = _number((r.get('usage') or {}).get('cost'))
    if turns == 0:
        return None, False
    if any(v is None for v in nested.values()):
        complete = False
    return own + sum(v for v in nested.values() if v is not None), complete

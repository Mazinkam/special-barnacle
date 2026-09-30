"""Contamination flag (spec §2.1): did an attempt's agents look at the pinned tool copies?

The skill copy and the humain-terminal install are readable by the sandboxed agent (they must be, to run), and
for tasks on those very repos they may contain the solution. We cannot deny the reads, so we record them.
Only tool-call arguments are inspected (`tool_execution_start`/`_update` `args`, and `toolCall` blocks'
`arguments` in assistant `message_end` events of the `--mode json` stream), never prompts, headers or tool
results, which legitimately mention these paths.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

from bench.tools import primary_binary

MAX_EVIDENCE = 5
_SNIPPET = 120


def _forms(path: str) -> list[str]:
    real = os.path.realpath(path)
    forms = {real, os.path.abspath(os.path.expanduser(path))}
    home = os.path.expanduser('~')
    for f in list(forms):
        if f.startswith(home + os.sep):
            forms.add('~' + f[len(home):])
    return sorted(forms)


def tool_locations(cfg) -> list[str]:
    """skill_root, the directory holding the resolved binary, and the pinned install root next to it."""
    locs = _forms(str(cfg.skill_root))
    binary = primary_binary(cfg.binary)
    if binary:
        locs += _forms(str(Path(binary).parent))
        for d in list(Path(binary).parents)[:3]:
            if (d / 'PINNED.json').is_file():
                locs += _forms(str(d))
                break
    return sorted(set(locs))


def _strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from _strings(v)


def _tool_calls(event: dict):
    """(tool name, arguments) pairs that the event records as tool invocations."""
    kind = event.get('type')
    if kind in ('tool_execution_start', 'tool_execution_update'):
        yield str(event.get('toolName')), event.get('args')
    elif kind == 'message_end':
        msg = event.get('message') or {}
        if isinstance(msg, dict) and msg.get('role') == 'assistant' and isinstance(msg.get('content'), list):
            for block in msg['content']:
                if isinstance(block, dict) and block.get('type') == 'toolCall':
                    yield str(block.get('name')), block.get('arguments')


def _events(path: Path):
    try:
        text = path.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return
    for line in text.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict):
            yield event


def scan_attempt(agent_log: Path, run_dirs: list[Path], locations: list[str]) -> tuple[bool, list[str]]:
    """Scan the attempt's own event stream and the child `*.events.jsonl` logs of its orchestrator runs."""
    patterns = [re.compile(re.escape(loc.rstrip(os.sep)) + r'(?![\w.-])') for loc in locations if loc.strip(os.sep)]
    files = [Path(agent_log)] + [f for d in run_dirs for f in sorted(Path(d).glob('*.events.jsonl'))]
    evidence: list[str] = []
    found = False
    for f in files:
        for event in _events(f):
            for name, args in _tool_calls(event):
                for s in _strings(args):
                    m = next((m for p in patterns if (m := p.search(s))), None)
                    if not m:
                        continue
                    found = True
                    start = max(0, m.start() - 30)
                    item = f'{f.name}: {name}: {" ".join(s[start:start + _SNIPPET].split())}'
                    if item not in evidence and len(evidence) < MAX_EVIDENCE:
                        evidence.append(item)
                    break
    return found, evidence

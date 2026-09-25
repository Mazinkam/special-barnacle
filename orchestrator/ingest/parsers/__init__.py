"""Per-runtime session parsers: identify a harness, read its log incrementally.

Split out of `orchestrator/ingest.py` (B3, `docs/architecture-review.md`). Each reader is a pure
step `(record, state) -> call | None` over a small JSON-serializable `state`, so a checkpoint can
carry the context (session id, per-turn models, cwd) needed to continue mid-file. `valid_state`
says whether a state read back from a checkpoint is one this parser can continue from; anything
else costs a full read, never a crash or a mis-attribution. `read_humain_terminal`/`read_codex`
remain the whole-file conveniences. The per-runtime record shapes themselves live in
`humain_terminal.py`/`codex.py`.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, BinaryIO, Callable, Iterator, NamedTuple, Optional

from ...runtime import iter_jsonl_from, open_binary
from .codex import _codex_state, _codex_state_ok, _parse_codex
from .humain_terminal import _humain_terminal_state, _humain_terminal_state_ok, _parse_humain_terminal

HUMAIN_TERMINAL = 'humain-terminal'
CODEX = 'codex'


def _lines(source: Path | BinaryIO) -> Iterator[dict[str, Any]]:
    """Every parseable JSON object line of a Path or open binary file, including an unterminated last line."""
    with open_binary(source) as handle:
        handle.seek(0)
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if isinstance(record, dict):
                yield record


class Parser(NamedTuple):
    initial: Callable[[Path], dict[str, Any]]
    step: Callable[[dict[str, Any], dict[str, Any]], Optional[dict[str, Any]]]
    valid_state: Callable[[dict[str, Any]], bool]


PARSERS: dict[str, Parser] = {
    HUMAIN_TERMINAL: Parser(_humain_terminal_state, _parse_humain_terminal, _humain_terminal_state_ok),
    CODEX: Parser(_codex_state, _parse_codex, _codex_state_ok),
}


def read_calls(path: Path, runtime: str, *, offset: int = 0, state: dict[str, Any] | None = None,
               handle: BinaryIO | None = None) -> tuple[list[dict[str, Any]], int, dict[str, Any]]:
    """Calls from the complete lines of `path` at or after `offset`; returns (calls, end offset, reader state).

    A trailing line without its newline is a torn or in-progress write: it is not parsed and the
    returned offset stops before it, so the next pass reads it whole. `state` is the reader
    context returned by a previous pass (copied, never mutated) or None to start at byte 0.
    `handle`, when given, is the already open file to read (so identity checks, this scan and the
    fingerprints all see one inode); `path` then only names it.
    """
    parser = PARSERS[runtime]
    state = json.loads(json.dumps(state)) if state else parser.initial(path)
    calls: list[dict[str, Any]] = []
    end = offset
    for record, line_end in iter_jsonl_from(handle if handle is not None else path, offset):
        end = line_end
        if isinstance(record, dict):
            call = parser.step(record, state)
            if call is not None:
                calls.append(call)
    return calls, end, state


def read_humain_terminal(path: Path) -> list[dict[str, Any]]:
    return read_calls(path, HUMAIN_TERMINAL)[0]


def read_codex(path: Path) -> list[dict[str, Any]]:
    return read_calls(path, CODEX)[0]


READERS: dict[str, Callable[[Path], list[dict[str, Any]]]] = {
    HUMAIN_TERMINAL: read_humain_terminal,
    CODEX: read_codex,
}


def detect_runtime(path: Path | BinaryIO) -> Optional[str]:
    """Identify the harness from the log's own record shapes, not from its file name."""
    for index, record in enumerate(_lines(path)):
        if record.get('type') == 'token_usage_record':
            return CODEX
        if record.get('type') == 'session_meta' and isinstance(record.get('payload'), dict):
            return CODEX
        message = record.get('message')
        if isinstance(message, dict) and 'usage' in message:
            return HUMAIN_TERMINAL
        if record.get('type') in {'session', 'model_change'} and 'payload' not in record:
            return HUMAIN_TERMINAL
        if index > 400:
            break
    return None

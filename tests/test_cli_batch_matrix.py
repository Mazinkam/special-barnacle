"""Table-driven regression test for `orchestrator.cli`'s `batch` command's JSON body/exit-code contract.

Runs `cli.main()` in-process (never a subprocess: fault injection needs `mock.patch` to reach into
the same interpreter that executes the write) against a temporary state root, for every outcome the
durable-write path can report: `ok`, `invalid`, `append_failed`, `checkpoint_failed`, ledger
`refresh_failed` and dashboard `refresh_failed`. Each case asserts the exact JSON body key set and
the exit code, matching what commit `4284a92` (pre-B2 modularization) produced for the same inputs —
verified by running this same matrix, by hand, against a scratch `git worktree` checked out at that
commit; see `docs/architecture-review.md` B2.

`checkpoint_failed` and both `refresh_failed` cases share exit code 3 (`EXIT_REFRESH_FAILED`): the
contract (`orchestrator/contract.json`) has no separate exit code for a checkpoint failure, and
`cli._write` maps every `result['ok'] is False` outcome coming out of `write_batch`/
`refresh_after_write` to that one code. `invalid` and `append_failed` are raised as exceptions before
`write_batch` returns a full result, so their body is the smaller `cli._failure` shape (no
`format_version`/`statuses`); every other case returns `write_batch`'s full result (minus `records`).
"""
from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from orchestrator import cli, record_batch
from orchestrator.app import refresh as app_refresh

#: `cli._write`'s two body shapes: the exception-raised failure (`cli._failure`) has no
#: `format_version`/`statuses`; everything that returns from `write_batch` itself has both.
FAILURE_KEYS = frozenset({'ok', 'status', 'error', 'persisted', 'duplicates',
                          'ledger_updated', 'dashboard_updated', 'retry'})
WRITE_BATCH_KEYS = FAILURE_KEYS | {'format_version', 'statuses'}

BATCH_RECORD = [{'stream': 'event', 'record_id': 'e1', 'event': 'run_started', 'run_id': 'r1'}]


def _run_cli_main(argv: list[str], root: Path) -> tuple[int, str]:
    """Run `cli.main()` with `sys.argv`/`cli.ROOT` swapped in, capturing stdout; return (exit code, stdout).

    A clean `SystemExit` (with an int code) is the batch command's normal path; anything else would
    be a bug in the command itself, not this harness, so it is left to propagate and fail the test.
    """
    with patch('sys.argv', argv), patch.object(cli, 'ROOT', root), \
         patch('sys.stdout', new_callable=io.StringIO) as out:
        try:
            cli.main()
            code = 0
        except SystemExit as exc:
            code = exc.code
        return code, out.getvalue()


def _fail_append(path, lines, **kwargs):
    raise OSError(28, 'No space left on device')


def _fail_checkpoint(root, index):
    raise OSError(28, 'No space left on device (checkpoint)')


@contextlib.contextmanager
def _ok():
    yield


@contextlib.contextmanager
def _append_failed():
    with patch.object(record_batch, '_append_stream', _fail_append):
        yield


@contextlib.contextmanager
def _checkpoint_failed():
    with patch.object(record_batch, '_write_checkpoint', _fail_checkpoint):
        yield


@contextlib.contextmanager
def _ledger_refresh_failed():
    with patch.object(record_batch, 'ledger_is_current', return_value=False), \
         patch.object(record_batch, 'replay_ledger', side_effect=RuntimeError('ledger boom')):
        yield


@contextlib.contextmanager
def _dashboard_refresh_failed():
    with patch.object(app_refresh, 'generate_dashboard', side_effect=RuntimeError('dashboard boom')):
        yield


class Case:
    def __init__(self, name, *, argv_payload, fault, exit_code, status, key_set):
        self.name = name; self.argv_payload = argv_payload; self.fault = fault
        self.exit_code = exit_code; self.status = status; self.key_set = key_set


CASES = [
    Case('ok', argv_payload=json.dumps(BATCH_RECORD), fault=_ok,
         exit_code=0, status='ok', key_set=WRITE_BATCH_KEYS),
    Case('invalid', argv_payload='not json', fault=_ok,
         exit_code=1, status='invalid', key_set=FAILURE_KEYS),
    Case('append_failed', argv_payload=json.dumps(BATCH_RECORD), fault=_append_failed,
         exit_code=2, status='append_failed', key_set=FAILURE_KEYS),
    Case('checkpoint_failed', argv_payload=json.dumps(BATCH_RECORD), fault=_checkpoint_failed,
         exit_code=3, status='checkpoint_failed', key_set=WRITE_BATCH_KEYS),
    Case('ledger_refresh_failed', argv_payload=json.dumps(BATCH_RECORD), fault=_ledger_refresh_failed,
         exit_code=3, status='refresh_failed', key_set=WRITE_BATCH_KEYS),
    Case('dashboard_refresh_failed', argv_payload=json.dumps(BATCH_RECORD), fault=_dashboard_refresh_failed,
         exit_code=3, status='refresh_failed', key_set=WRITE_BATCH_KEYS),
]


@pytest.mark.parametrize('case', CASES, ids=[c.name for c in CASES])
def test_batch_command_body_and_exit_code(tmp_path, case):
    root = tmp_path / 'state'
    root.mkdir()
    argv = ['orchestrator', 'batch', case.argv_payload]

    with case.fault():
        code, out = _run_cli_main(argv, root)

    assert code == case.exit_code, out
    body = json.loads(out)
    assert set(body) == case.key_set, sorted(body)
    assert body['status'] == case.status
    assert body['ok'] == (case.status == 'ok')

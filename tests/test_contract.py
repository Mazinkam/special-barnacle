"""Parity between `orchestrator/contract.json` and the Python constants derived from it
(`orchestrator/contract.py`), plus the CLI/record-batch/runtime behaviour that must match
the contract's exit codes, statuses, limits, redaction regex and state-root env var.

The TS-side mirror of this test is
`bridge/extensions/orchestrator/contract.test.ts`.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from datetime import datetime, timezone

from orchestrator import archive, contract, record_batch, record_index, cli, runtime
from orchestrator.outcomes import _dt as outcomes_dt
from orchestrator.run_evidence import _parse_ts as run_evidence_parse_ts

REPO_ROOT = Path(__file__).resolve().parents[1]
CONTRACT_JSON = REPO_ROOT / 'orchestrator' / 'contract.json'
CONTRACT_SYMLINK = REPO_ROOT / 'bridge' / 'extensions' / 'orchestrator' / 'contract.json'


def _raw_contract() -> dict:
    return json.loads(CONTRACT_JSON.read_text(encoding='utf-8'))


def test_bridge_symlink_points_at_the_same_file() -> None:
    assert CONTRACT_SYMLINK.is_symlink()
    assert CONTRACT_SYMLINK.resolve() == CONTRACT_JSON.resolve()
    assert json.loads(CONTRACT_SYMLINK.read_text(encoding='utf-8')) == _raw_contract()


def test_streams_match_contract() -> None:
    raw = _raw_contract()
    assert contract.STREAMS == raw['streams']
    # record_index.STREAMS is the historical name; it must still be exactly this dict.
    assert record_index.STREAMS == contract.STREAMS


def test_ingest_status_file_matches_contract() -> None:
    assert contract.INGEST_STATUS_FILE == _raw_contract()['ingest_status_file']


def test_never_archive_files_match_contract() -> None:
    raw = _raw_contract()
    assert contract.NEVER_ARCHIVE_FILES == frozenset(raw['never_archive_files'])
    # every stream file and the ingest status file must never be archived
    assert set(contract.STREAMS.values()) <= contract.NEVER_ARCHIVE_FILES
    assert contract.INGEST_STATUS_FILE in contract.NEVER_ARCHIVE_FILES


def test_batch_limits_and_exit_codes_match_contract() -> None:
    raw = _raw_contract()['batch']
    assert contract.MAX_BATCH_RECORDS == raw['max_records'] == record_batch.MAX_BATCH_RECORDS
    assert contract.MAX_RECORD_ID_LENGTH == raw['max_record_id_length'] == record_batch.MAX_RECORD_ID_LENGTH
    assert contract.EXIT_OK == raw['exit_codes']['ok'] == cli.EXIT_OK
    assert contract.EXIT_INVALID == raw['exit_codes']['invalid'] == cli.EXIT_INVALID
    assert contract.EXIT_APPEND_FAILED == raw['exit_codes']['append_failed'] == cli.EXIT_APPEND_FAILED
    assert contract.EXIT_REFRESH_FAILED == raw['exit_codes']['refresh_failed'] == cli.EXIT_REFRESH_FAILED
    assert contract.RETRY_SAME_IDS == raw['retry_same_ids'] == record_batch.RETRY_SAME_IDS


def test_batch_statuses_match_contract() -> None:
    raw = _raw_contract()['batch']['statuses']
    assert contract.STATUS_OK == raw['ok']
    assert contract.STATUS_INVALID == raw['invalid']
    assert contract.STATUS_APPEND_FAILED == raw['append_failed']
    assert contract.STATUS_REFRESH_FAILED == raw['refresh_failed']
    assert contract.STATUS_CHECKPOINT_FAILED == raw['checkpoint_failed']


def test_python_redaction_regex_matches_contract_and_cli() -> None:
    raw = _raw_contract()['redaction_regex']
    assert contract.PATH_REDACTION_RE.pattern == raw['python']
    assert cli._PATH_RE.pattern == raw['python']
    # Behaviour check: the Python regex stops at a space/tab/newline/pipe, but not at other
    # whitespace such as a non-breaking space — this is the documented difference from the TS side.
    assert cli._redact_paths('path: /Users/alice/proj file') == 'path: <path> file'


def test_state_root_env_vars_and_default_match_contract() -> None:
    raw = _raw_contract()['state_root']
    assert contract.STATE_ROOT_ENV_VAR == raw['env_vars']['python'] == 'CODING_AGENT_ORCHESTRATOR_HOME'
    assert contract.TS_STATE_ROOT_ENV_VAR == raw['env_vars']['ts'] == 'HUMAIN_ORCHESTRATOR_STATE_ROOT'
    assert contract.DEFAULT_STATE_ROOT == raw['default']


def test_default_state_root_uses_contract_env_var_and_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(contract.STATE_ROOT_ENV_VAR, raising=False)
    assert runtime.default_state_root() == Path(contract.DEFAULT_STATE_ROOT).expanduser()
    monkeypatch.setenv(contract.STATE_ROOT_ENV_VAR, '/tmp/some-other-root')
    assert runtime.default_state_root() == Path('/tmp/some-other-root')


# --- parse_iso_ts: exact per-caller semantics (B1 review) ------------------------------
#
# Reference oracles: the *original* bodies of `outcomes._dt` and `run_evidence._parse_ts`
# before they were unified into `vocab.parse_iso_ts`, copied here verbatim (see
# `git show 1a1e439:orchestrator/outcomes.py` and `git show 1a1e439:orchestrator/run_evidence.py`).
# `vocab.parse_iso_ts(value, coerce_str=False)` must equal `_old_outcomes_dt` on every input,
# and the default `vocab.parse_iso_ts(value)` (coerce_str=True) must equal `_old_run_evidence_parse_ts`.


def _old_outcomes_dt(s):
    try:
        return datetime.fromisoformat(s.replace('Z', '+00:00'))
    except Exception:
        return None


def _old_run_evidence_parse_ts(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except Exception:
        return None


_PARSE_TS_SAMPLES = [
    None,
    '',
    'not-a-date',
    '2024-01-01T00:00:00Z',
    '2024-01-01T00:00:00',
    '2024-01-01T00:00:00+02:00',
    20240101,
    3.14,
    datetime(2024, 1, 1, 12, 0, 0),
    datetime(2024, 1, 1, 12, 0, 0, tzinfo=timezone.utc),
    0,
    False,
]


@pytest.mark.parametrize('value', _PARSE_TS_SAMPLES)
def test_parse_iso_ts_matches_old_outcomes_dt(value) -> None:
    assert outcomes_dt(value) == _old_outcomes_dt(value)


@pytest.mark.parametrize('value', _PARSE_TS_SAMPLES)
def test_parse_iso_ts_matches_old_run_evidence_parse_ts(value) -> None:
    assert run_evidence_parse_ts(value) == _old_run_evidence_parse_ts(value)


def test_parse_iso_ts_callers_disagree_on_datetime_input_on_purpose() -> None:
    # This is the exact case the B1 review flagged: the two old functions are NOT
    # behaviourally identical on non-str input, so each caller must keep its own behaviour.
    dt = datetime(2024, 1, 1, 12, 0, 0)
    assert outcomes_dt(dt) is None
    assert run_evidence_parse_ts(dt) == dt


# --- B1 review: consumer-level parity, not just the JSON --------------------------------


def test_archive_never_archive_matches_contract() -> None:
    assert archive.NEVER_ARCHIVE == contract.NEVER_ARCHIVE_FILES


def test_record_batch_limits_exit_and_status_constants_match_contract() -> None:
    assert record_batch.MAX_BATCH_RECORDS == contract.MAX_BATCH_RECORDS
    assert record_batch.MAX_RECORD_ID_LENGTH == contract.MAX_RECORD_ID_LENGTH
    assert record_batch.RETRY_SAME_IDS == contract.RETRY_SAME_IDS


def test_cli_redaction_constant_matches_contract() -> None:
    assert cli._PATH_RE is contract.PATH_REDACTION_RE
    assert cli._PATH_RE.pattern == contract.PATH_REDACTION_RE.pattern


def test_runtime_state_root_env_var_matches_contract() -> None:
    """`runtime.default_state_root` must read the contract's env var name, not a re-typed copy."""
    import inspect
    source = inspect.getsource(runtime.default_state_root)
    assert 'STATE_ROOT_ENV_VAR' in source
    assert contract.STATE_ROOT_ENV_VAR == 'CODING_AGENT_ORCHESTRATOR_HOME'


def test_install_sh_default_state_root_matches_contract() -> None:
    """The active shell fallback must match `state_root.default` in the contract."""
    import re

    install_sh = (REPO_ROOT / 'install.sh').read_text(encoding='utf-8')
    assignments = [
        line for line in install_sh.splitlines()
        if not line.lstrip().startswith('#') and re.match(r'\s*STATE_ROOT=', line)
    ]
    assert len(assignments) == 1
    match = re.fullmatch(
        r'\s*STATE_ROOT="\$\{HUMAIN_ORCHESTRATOR_STATE_ROOT:-(?P<default>[^}]*)\}"\s*',
        assignments[0],
    )
    assert match is not None
    assert match.group('default') == '$HOME' + contract.DEFAULT_STATE_ROOT.removeprefix('~')

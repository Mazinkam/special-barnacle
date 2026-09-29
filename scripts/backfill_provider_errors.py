#!/usr/bin/env python3
"""One-off legacy provider error scan. Dry-run unless --write and --state-dir are explicit.

Evidence comes from the harness's own structured error fields in runs/<run>/*.events.jsonl
(assistant messages with stopReason "error", an errorMessage and an epoch-ms timestamp), never
from model text. Dated run.log/*.stderr.log lines are only used for runs without such rows;
undated lines are ignored because they carry no observation time.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

# Runnable as `python3 scripts/backfill_provider_errors.py` without PYTHONPATH.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from orchestrator.core.env import default_state_root  # noqa: E402
from orchestrator.record_batch import write_batch  # noqa: E402

CODES = (
    ('quota', re.compile(r'\b(?:quota exceeded|rate limit(?: exceeded)?|usage limit reached)\b', re.I)),
    ('ENOTFOUND', re.compile(r'\bENOTFOUND\b', re.I)),
    ('ECONNRESET', re.compile(r'\bECONNRESET\b', re.I)),
    ('ETIMEDOUT', re.compile(r'\bETIMEDOUT\b', re.I)),
    ('fetch_failed', re.compile(r'\bfetch failed\b', re.I)),
    ('stream_canceled', re.compile(r'\b(?:pending )?stream (?:has been |was )?cance(?:led|lled)\b', re.I)),
    ('stream_no_stop_reason', re.compile(r'\b(?:stream ended without (?:a )?stop reason|no stop reason)\b', re.I)),
    ('http_5xx', re.compile(r'\b(?:HTTP|status(?: code)?|error|code)[\s:=#/-]+5\d\d\b', re.I)),
)
STAMP = re.compile(r'\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)\b')
# Only known provider endpoint syntax is evidence of provider identity. Never infer
# identity from arbitrary path-like diagnostic text (which may contain secrets).
BEDROCK_HOST = re.compile(r'bedrock-runtime\.[a-z]{2}(?:-[a-z]+)+-\d\.amazonaws\.com', re.I)
URL = re.compile(r'https?://[^\s\"\'<>]{1,512}', re.I)
DNS = re.compile(r'\bgetaddrinfo\s+ENOTFOUND\s+([^\s\"\'<>\)]{1,253})(?=\)(?=\s|$)|\s|$)', re.I)


def provider_endpoint(line: str) -> str | None:
    """Return a bounded, exact known endpoint host, never URL credentials/path."""
    for match in URL.finditer(line):
        try:
            parsed = urlsplit(match.group())
            host = parsed.hostname
            _ = parsed.port  # Reject malformed ports, not just malformed hosts.
            if parsed.username is None and parsed.password is None and host and BEDROCK_HOST.fullmatch(host):
                return host.lower()
        except ValueError:
            continue
    for match in DNS.finditer(line):
        host = match.group(1)
        if BEDROCK_HOST.fullmatch(host):
            return host.lower()
    return None


# Bounded, but above the largest real agent_end/worker-result lines (~12 MB) so no evidence is lost.
MAX_LINE_BYTES = 16 << 20
MAX_DEPTH = 64
MAX_NODES = 200_000
# Sane epoch-ms bounds: 2020-01-01 .. 2100-01-01.
MIN_TS_MS, MAX_TS_MS = 1_577_836_800_000, 4_102_444_800_000
# Kept within record_batch's own provider/model token limits.
SAFE_PROVIDER = re.compile(r'[a-z0-9-]{1,48}')
SAFE_MODEL = re.compile(r'[A-Za-z0-9._/-]{1,120}')
EVENTS_SUFFIX = '.events.jsonl'


def classify(text: str) -> str | None:
    """First CODES entry matching the (bounded) text."""
    return next((code for code, pattern in CODES if pattern.search(text)), None)


def _safe(value: object, pattern: re.Pattern[str]) -> str:
    return value if isinstance(value, str) and pattern.fullmatch(value) else 'unknown'


def error_messages(event: object):
    """Yield (message, nested) for assistant error messages anywhere in event.

    Bounded by depth and node count. nested is true below a details.results path.
    """
    stack = [(event, 0, False, None)]
    nodes = 0
    while stack and nodes < MAX_NODES:
        node, depth, nested, key = stack.pop()
        nodes += 1
        if depth > MAX_DEPTH:
            continue
        if isinstance(node, dict):
            if (node.get('role') == 'assistant' and node.get('stopReason') == 'error'
                    and isinstance(node.get('errorMessage'), str)):
                ts = node.get('timestamp')
                if isinstance(ts, int) and not isinstance(ts, bool) and MIN_TS_MS <= ts <= MAX_TS_MS:
                    yield node, nested
            for child_key, child in node.items():
                if isinstance(child, (dict, list)):
                    child_nested = nested or (key == 'details' and child_key == 'results')
                    stack.append((child, depth + 1, child_nested, child_key))
        elif isinstance(node, list):
            for child in node:
                if isinstance(child, (dict, list)):
                    stack.append((child, depth + 1, nested, key))


def _bounded_lines(path: Path):
    """Yield complete lines up to MAX_LINE_BYTES; skip (drain) longer ones."""
    with path.open('rb') as source:
        while True:
            line = source.readline(MAX_LINE_BYTES + 1)
            if not line:
                return
            if len(line) > MAX_LINE_BYTES and not line.endswith(b'\n'):
                while line and not line.endswith(b'\n'):
                    line = source.readline(MAX_LINE_BYTES)
                continue
            yield line


def structured_rows(root: Path, run: Path, path: Path) -> list[dict]:
    relative = path.relative_to(root).as_posix()
    task_id = path.name[:-len(EVENTS_SUFFIX)]
    seen: set[tuple] = set()
    rows = []
    for line in _bounded_lines(path):
        # Cheap prefilter: only lines with an error stop reason can hold evidence.
        if b'"stopReason"' not in line or b'"error"' not in line:
            continue
        try:
            event = json.loads(line)
        except (ValueError, RecursionError):
            continue
        for message, nested in error_messages(event):
            text = message['errorMessage'][:16384]
            code = classify(text)
            if code is None:
                continue
            provider = _safe(message.get('provider'), SAFE_PROVIDER)
            model = _safe(message.get('model'), SAFE_MODEL)
            ts_ms = message['timestamp']
            key = (provider, model, ts_ms, code, nested)
            if key in seen:
                continue
            seen.add(key)
            host = provider_endpoint(text)
            stamp = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).isoformat(timespec='milliseconds')
            stamp = stamp.replace('+00:00', 'Z')
            identity = f'{relative}:{provider}:{model}:{ts_ms}:{code}:{str(nested).lower()}'
            rows.append({'stream': 'event', 'event': 'provider_error',
                         'record_id': 'provider-backfill-' + hashlib.sha256(identity.encode()).hexdigest(),
                         'run_id': run.name, 'task_id': task_id, 'provider': provider,
                         'model': model,
                         'error_code': code, 'nested': nested, 'count': 1,
                         **({'endpoint_host': host} if host else {}),
                         'ts': stamp, 'first_ts': stamp, 'last_ts': stamp,
                         'source': 'legacy_provider_backfill'})
    return rows


def text_rows(root: Path, run: Path, path: Path) -> list[dict]:
    """Dated text-log lines only; an undated line has no observation time."""
    relative = path.relative_to(root).as_posix()
    rows = []
    with path.open(encoding='utf-8', errors='replace') as source:
        for line_number, line in enumerate(source, 1):
            bounded = line[:16384]
            code = classify(bounded)
            stamp = STAMP.search(bounded) if code else None
            if stamp is None:
                continue
            host = provider_endpoint(bounded)
            identity = f'{relative}:{line_number}:{code}'
            rows.append({'stream': 'event', 'event': 'provider_error',
                         'record_id': 'provider-backfill-' + hashlib.sha256(identity.encode()).hexdigest(),
                         'run_id': run.name, 'provider': 'amazon-bedrock' if host else 'unknown',
                         'error_code': code, 'count': 1,
                         **({'endpoint_host': host} if host else {}),
                         'ts': stamp.group(), 'first_ts': stamp.group(), 'last_ts': stamp.group(),
                         'source': 'legacy_provider_backfill'})
    return rows


def backfill(root: Path, *, write: bool = False) -> dict[str, int]:
    """Scan only regular files below root/runs, never following a symlink out of root."""
    root = Path(root)
    if write and root.resolve() == default_state_root().resolve():
        raise ValueError('refusing to write the live default state directory')
    if root.is_symlink() or not root.is_dir():
        raise ValueError('state directory must be an existing, non-symlink directory')
    records = []
    runs = root / 'runs'
    if runs.is_symlink():
        raise ValueError('runs directory must not be a symlink')
    if runs.is_dir():
        for run in sorted(runs.iterdir()):
            if run.is_symlink() or not run.is_dir():
                continue
            files = [path for path in sorted(run.iterdir()) if not path.is_symlink() and path.is_file()]
            structured = [row for path in files if path.name.endswith(EVENTS_SUFFIX)
                          for row in structured_rows(root, run, path)]
            records.extend(structured)
            if structured:
                continue  # Never double-count a run's evidence from its text logs.
            for path in files:
                if path.name == 'run.log' or path.name.endswith('.stderr.log'):
                    records.extend(text_rows(root, run, path))
    persisted = 0
    if write:
        for index in range(0, len(records), 500):
            result = write_batch(root, records[index:index + 500], refresh=False)
            if not result['ok']:
                raise RuntimeError(result['error'])
            persisted += result['persisted']['event']
    return {'candidates': len(records), 'persisted': persisted}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', type=Path, help='Explicit state directory (required for --write)')
    parser.add_argument('--write', action='store_true', help='Opt in to appending normalized event records')
    args = parser.parse_args()
    if args.state_dir is None:
        parser.error('--state-dir is required; the default state root is never read or written')
    print(backfill(args.state_dir, write=args.write))


if __name__ == '__main__':
    main()

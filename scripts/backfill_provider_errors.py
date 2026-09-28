#!/usr/bin/env python3
"""One-off legacy provider error scan. Dry-run unless --write and --state-dir are explicit."""
from __future__ import annotations

import argparse
import hashlib
import re
from pathlib import Path
from urllib.parse import urlsplit

from orchestrator.core.env import default_state_root
from orchestrator.record_batch import write_batch

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
DNS = re.compile(r'\bgetaddrinfo\s+ENOTFOUND\s+([^\s\"\'<>]{1,253})(?=\s|$)', re.I)


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


def backfill(root: Path, *, write: bool = False) -> dict[str, int]:
    """Scan only regular logs below root/runs, never following a symlink out of root."""
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
            for path in sorted(run.iterdir()):
                if path.is_symlink() or not path.is_file() or (path.name != 'run.log' and not path.name.endswith('.stderr.log')):
                    continue
                relative = path.relative_to(root).as_posix()
                with path.open(encoding='utf-8', errors='replace') as source:
                    for line_number, line in enumerate(source, 1):
                        bounded = line[:16384]
                        match = next(((code, pattern) for code, pattern in CODES if pattern.search(bounded)), None)
                        if match is None:
                            continue
                        code = match[0]
                        stamp = STAMP.search(bounded)
                        host = provider_endpoint(bounded)
                        identity = f'{relative}:{line_number}:{code}'
                        record_id = 'provider-backfill-' + hashlib.sha256(identity.encode()).hexdigest()
                        records.append({'stream': 'event', 'event': 'provider_error', 'record_id': record_id,
                                        'run_id': run.name, 'provider': 'amazon-bedrock' if host else 'unknown',
                                        'error_code': code, 'count': 1,
                                        **({'endpoint_host': host} if host else {}),
                                        **({'ts': stamp.group(), 'first_ts': stamp.group(), 'last_ts': stamp.group()}
                                           if stamp else {'timestamp_precision': 'unknown'}),
                                        'source': 'legacy_provider_backfill'})
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

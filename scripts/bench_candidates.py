#!/usr/bin/env python3
"""List recent commits that change both source and tests, as benchmark replay candidates (spec §2.1).

    python3 scripts/bench_candidates.py REPO [--since 90.days] [--json]

The proposed scope band is a starting label only (by source-file and top-level-directory count);
a human confirms scope_band and risk before any arm runs.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess

TEST = re.compile(r'(^|/)(tests?/|test_[^/]+\.py$|[^/]+_test\.(py|go)$|[^/]+\.(test|spec)\.[jt]sx?$)')


def _band(src: list[str]) -> str:
    if len(src) == 1:
        return 'tiny'
    if len(src) <= 3:
        return 'small'
    return 'multi_file' if len({f.split('/')[0] for f in src}) <= 2 else 'cross_system'


def list_candidates(repo: str, since: str) -> list[dict]:
    out = subprocess.run(['git', '-C', repo, 'log', f'--since={since}', '--no-merges', '--name-only',
                          '--format=@@%H%x09%s'], capture_output=True, text=True, check=True).stdout
    rows = []
    for block in out.split('@@')[1:]:
        lines = [line for line in block.splitlines() if line.strip()]
        if not lines:
            continue
        sha, _, subject = lines[0].partition('\t')
        files = lines[1:]
        tests = [f for f in files if TEST.search(f)]
        src = [f for f in files if f not in tests]
        if tests and src:
            rows.append({'sha': sha, 'band': _band(src), 'src': len(src), 'tests': len(tests), 'subject': subject})
    return rows


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument('repo')
    p.add_argument('--since', default='90.days')
    p.add_argument('--json', action='store_true')
    a = p.parse_args()
    rows = list_candidates(a.repo, a.since)
    if a.json:
        print(json.dumps(rows, indent=2))
    else:
        for r in rows:
            print(f"{r['sha']}\t{r['band']}\tsrc={r['src']}\ttests={r['tests']}\t{r['subject']}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

"""Reproducible synthetic session-ingestion benchmark (never touches live state).

    PYTHONDONTWRITEBYTECODE=1 python3 -B -m tests.ingest_benchmark [--scales 1,2,4] [--repeat 20] [--json]

Everything is generated into a fresh temporary directory: a HUMAIN Terminal session log with
``400 * scale`` assistant calls (plus user/tool-result noise so line sizes are realistic), and a
state root whose ``metrics.jsonl`` holds ``20_000 * scale`` historical rows, one quarter of them
``session_ingest`` rows of other sessions (the shape the live root has). Per scale it measures,
in this process and through the public ``ingest_paths`` API only:

* ``unchanged_session``   — re-ingesting the same, unmodified session at session granularity
                            (what the HT ``agent_settled`` hook does on every quiet turn);
* ``unchanged_per_call``  — the same at per-call granularity (launchd/backfill default);
* ``one_new_turn``        — one assistant call appended to the session between ingests.

Reported per operation: median wall-clock milliseconds, median logical bytes read/written by
the ingest (Python file objects and SQLite VFS, via ``tests.record_io_probe``; a platform without
the VFS hook reports ``null`` for bytes rather than Python-only counts), and the number of metric
rows the run appended (must be 0 for the unchanged cases and 1 for ``one_new_turn``). RSS is the
process high-water mark including fixture generation and is only comparable between runs of this
same script. Run before and after a change with the same arguments.
"""
from __future__ import annotations

import argparse
import json
import resource
import statistics
import sys
import tempfile
import time
from pathlib import Path

from orchestrator.ingest import ingest_paths
from orchestrator.runtime import EventStore
from tests.record_io_probe import IoMeterUnsupported, measure_io

CALLS_PER_SCALE = 400
HISTORY_PER_SCALE = 20_000


def assistant_line(i: int, *, session: str = 'bench-session') -> str:
    return json.dumps({
        'type': 'message', 'id': f'asst-{i}', 'timestamp': f'2026-09-21T10:{i // 60 % 60:02d}:{i % 60:02d}.000Z',
        'message': {'role': 'assistant', 'model': 'claude-sonnet-4-5', 'provider': 'humain-node',
                    'content': [{'type': 'text', 'text': 'x' * 600}],
                    'usage': {'input': 20 + i, 'output': 200, 'cacheRead': 12_000, 'cacheWrite': 300,
                              'cacheWrite1h': 0, 'reasoning': 40, 'totalTokens': 12_560 + i}}}) + '\n'


def write_session(path: Path, calls: int) -> None:
    with path.open('w', encoding='utf-8') as out:
        out.write(json.dumps({'type': 'session', 'id': 'bench-session', 'cwd': '/work/forge'}) + '\n')
        for i in range(calls):
            out.write(json.dumps({'type': 'message', 'id': f'user-{i}', 'timestamp': '2026-09-21T10:00:00.000Z',
                                  'message': {'role': 'user', 'content': [{'type': 'text', 'text': 'y' * 300}]}}) + '\n')
            out.write(assistant_line(i))
            out.write(json.dumps({'type': 'message', 'id': f'tool-{i}',
                                  'message': {'role': 'toolResult', 'content': [{'type': 'text', 'text': 'z' * 900}]}}) + '\n')


def write_history(root: Path, rows: int) -> None:
    EventStore(root)  # streams exist, like a real root
    with (root / 'metrics.jsonl').open('a', encoding='utf-8') as out:
        for i in range(rows):
            if i % 4 == 0:
                row = {'ts': '2026-09-20T00:00:00+00:00', 'agent_runtime': 'humain-terminal', 'repository': '/work/forge',
                       'event': 'model_call', 'source': 'session_ingest', 'role': 'interactive_session',
                       'session_id': f'other-{i // 40}', 'call_id': f'{i:016x}', 'granularity': 'call',
                       'model': 'claude-sonnet-4-5', 'input_tokens': 1000, 'output_tokens': 100, 'cached_input_tokens': 800,
                       'cache_write_tokens': 0, 'reasoning_output_tokens': 0, 'total_tokens': 1100,
                       'cost_usd': 0.0021, 'cost_source': 'estimated-from-reported-tokens', 'record_id': f'h-{i}'}
            else:
                row = {'ts': '2026-09-20T00:00:00+00:00', 'agent_runtime': 'humain-terminal', 'repository': '/work/forge',
                       'event': 'model_call', 'run_id': f'R{i // 50}', 'task_id': f'T{i}', 'model': 'claude-sonnet-4-5',
                       'input_tokens': 100, 'output_tokens': 50, 'cost_usd': 0.001, 'cost_source': 'reported', 'record_id': f'h-{i}'}
            out.write(json.dumps(row, sort_keys=True) + '\n')


def timed(fn, repeat: int) -> tuple[list[float], list[int], dict | None]:
    """Median wall ms and appended rows over `repeat` calls, then one metered call for bytes."""
    elapsed: list[float] = []; emitted: list[int] = []
    for _ in range(repeat):
        start = time.perf_counter(); result = fn(); elapsed.append(1000 * (time.perf_counter() - start))
        emitted.append(int(result['emitted']))
    counts = None
    try:
        with measure_io() as io:
            result = fn()
        counts = {'read_bytes': io['read'], 'write_bytes': io['write'], 'sqlite_read': io['sqlite_read'], 'sqlite_write': io['sqlite_write']}
        emitted.append(int(result['emitted']))
    except IoMeterUnsupported:
        pass
    return elapsed, emitted, counts


def bench_scale(scale: int, repeat: int) -> dict:
    with tempfile.TemporaryDirectory(prefix='orchestrator-ingest-bench-') as tmp:
        root = Path(tmp, 'state'); session = Path(tmp, 'sessions', '--work-forge--', 'bench_session.jsonl')
        session.parent.mkdir(parents=True)
        calls = CALLS_PER_SCALE * scale
        write_session(session, calls); write_history(root, HISTORY_PER_SCALE * scale)
        out: dict = {'scale': f'{scale}x', 'session_calls': calls, 'session_bytes': session.stat().st_size,
                     'history_rows': HISTORY_PER_SCALE * scale, 'metrics_bytes': (root / 'metrics.jsonl').stat().st_size}

        def run(granularity: str):
            return ingest_paths([session], runtime='humain-terminal', state_root=root, granularity=granularity)

        first = run('session'); assert first['emitted'] == 1, first
        for name, gran in (('unchanged_session', 'session'), ('unchanged_per_call', 'call')):
            if gran == 'call':
                # Per-call after session-level rows is a granularity transition; make the fixture
                # per-call first in a sibling root so this case measures a pure duplicate scan.
                root2 = Path(tmp, 'state-call'); write_history(root2, HISTORY_PER_SCALE * scale)
                ingest_paths([session], runtime='humain-terminal', state_root=root2, granularity='call')
                fn = lambda r=root2: ingest_paths([session], runtime='humain-terminal', state_root=r, granularity='call')  # noqa: E731
            else:
                fn = lambda: run('session')  # noqa: E731
            elapsed, emitted, counts = timed(fn, repeat)
            out[name] = {'median_ms': round(statistics.median(elapsed), 2), 'emitted_rows': sorted(set(emitted)), 'io': counts}

        counter = [calls]
        def one_new_turn():
            with session.open('a', encoding='utf-8') as handle:
                handle.write(assistant_line(counter[0])); counter[0] += 1
            return run('session')
        elapsed, emitted, counts = timed(one_new_turn, repeat)
        out['one_new_turn'] = {'median_ms': round(statistics.median(elapsed), 2), 'emitted_rows': sorted(set(emitted)), 'io': counts}
        return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--scales', default='1,2,4'); ap.add_argument('--repeat', type=int, default=20)
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
    results = [bench_scale(int(s), args.repeat) for s in args.scales.split(',') if s.strip()]
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    report = {'python': sys.version.split()[0], 'repeat': args.repeat, 'results': results,
              'process_peak_rss_mib': round(rss / (1024 ** 2 if sys.platform == 'darwin' else 1024), 1)}
    if args.json:
        print(json.dumps(report, indent=2)); return
    print(f'{"scale":<6}{"operation":<20}{"median_ms":>10}{"read_MiB":>10}{"write_KiB":>10}  emitted')
    for r in results:
        for op in ('unchanged_session', 'unchanged_per_call', 'one_new_turn'):
            m = r[op]; io = m['io'] or {}
            rd = '—' if not io else f'{io["read_bytes"] / 2 ** 20:.2f}'; wr = '—' if not io else f'{io["write_bytes"] / 1024:.1f}'
            print(f'{r["scale"]:<6}{op:<20}{m["median_ms"]:>10.2f}{rd:>10}{wr:>10}  {m["emitted_rows"]}')
        print(f'      (session {r["session_calls"]} calls / {r["session_bytes"] / 2 ** 20:.2f} MiB; metrics {r["history_rows"]} rows / {r["metrics_bytes"] / 2 ** 20:.2f} MiB)')
    print(f'process peak RSS {report["process_peak_rss_mib"]} MiB (includes fixture generation)')


if __name__ == '__main__':
    main()

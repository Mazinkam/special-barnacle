"""Before/after benchmark for the orchestrator refresh path on synthetic 1x/2x/4x fixtures.

    PYTHONDONTWRITEBYTECODE=1 python3 -B scripts/benchmark_refresh.py [--runs 500] [--repeat 5] [--scales 1,2,4] [--json]

Never reads live state: every fixture is written into a fresh temporary directory by
`tests.test_dashboard_refresh.write_synthetic_history` (`--source ROOT` copies the three JSONL
streams of an existing root into the temp directory instead and replicates them for 2x/4x with
re-suffixed identifiers). For each scale the script:

1. warms the fixture with one CLI `batch` call (cold record-index derivation + full ledger
   replay; reported as `cold_s`, not included in the medians);
2. measures `--repeat` CLI `batch` invocations of a `--batch-size`-record batch (durable append +
   incremental ledger + dashboard) and `--repeat` CLI `dashboard` invocations;
3. for comparison, measures writing the same records through the legacy one-record commands
   (`event`/`metric`/`outcome`), i.e. one subprocess per record.

Per measured operation it prints the subprocess count, median elapsed seconds, peak child RSS
(from `os.wait4` rusage, so it is the child's own high-water mark) and throughput in records per
second (records durably written *and* published per second of wall time). Peak RSS is reported in
MiB on both macOS (bytes) and Linux (KiB). Run before and after a change with the same arguments.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from tests.test_dashboard_refresh import write_synthetic_history  # noqa: E402

STREAMS = ('events.jsonl', 'metrics.jsonl', 'outcomes.jsonl')
ID_FIELDS = ('record_id', 'run_id', 'task_id', 'session_id', 'decision_id')


def rss_mib(ru_maxrss: int) -> float:
    return ru_maxrss / (1024 ** 2 if sys.platform == 'darwin' else 1024)


def cli_env(root: Path) -> dict[str, str]:
    return {**os.environ, 'CODING_AGENT_ORCHESTRATOR_HOME': str(root), 'CODING_AGENT_RUNTIME': 'benchmark',
            'CODING_AGENT_REPOSITORY': '/work/forge', 'PYTHONPATH': str(REPO), 'PYTHONDONTWRITEBYTECODE': '1'}


def run_cli(root: Path, *args: str, stdin: str | None = None) -> tuple[float, int, subprocess.CompletedProcess]:
    """Run one CLI subprocess; return (elapsed seconds, child ru_maxrss, completed process)."""
    proc = subprocess.Popen([sys.executable, '-B', '-m', 'orchestrator.cli', *args], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=cli_env(root), cwd=str(REPO))
    start = time.perf_counter()
    if stdin is not None: proc.stdin.write(stdin)
    proc.stdin.close()
    _, status, usage = os.wait4(proc.pid, 0)  # reap ourselves so the child's own rusage is available
    elapsed = time.perf_counter() - start
    out, err = proc.stdout.read(), proc.stderr.read(); proc.stdout.close(); proc.stderr.close()
    proc.returncode = code = os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else (status >> 8)
    completed = subprocess.CompletedProcess(proc.args, code, out, err)
    if code != 0:
        raise SystemExit(f'CLI {args[0]} failed ({code}):\n{out}\n{err}')
    return elapsed, usage.ru_maxrss, completed


def batch_records(tag: str, size: int) -> list[dict]:
    """`size` fresh records that touch all three streams (one run boundary)."""
    rid = f'bench-{tag}'
    records = [{'stream': 'event', 'record_id': f'{rid}-start', 'event': 'run_started', 'run_id': rid}]
    for k in range(max(0, size - 2)):
        records.append({'stream': 'metric', 'record_id': f'{rid}-m{k}', 'event': 'model_call', 'run_id': rid, 'task_id': f'{rid}-T{k}',
                        'role': 'worker', 'capability_class': 'implementation_fast', 'model': 'anthropic/claude-sonnet-4-5',
                        'input_tokens': 1200, 'output_tokens': 300, 'cost_usd': .012, 'cost_source': 'reported', 'task_class': 'crud',
                        'complexity': 3, 'risk': 'low'})
    records.append({'stream': 'outcome', 'record_id': f'{rid}-o', 'run_id': rid, 'task_id': 'run-complete', 'note': '{"retries":0}'})
    return records[:size] if size >= 2 else records[:1]


def copy_fixture(source: Path, root: Path, scale: int) -> dict[str, int]:
    """Copy the three streams of `source` into `root`, replicated `scale` times with re-suffixed ids."""
    root.mkdir(parents=True, exist_ok=True); counts = {}
    for name in STREAMS:
        src = source / name; n = 0
        with (root / name).open('wb') as out:
            if not src.exists(): counts[name] = 0; continue
            for copy in range(scale):
                with src.open('rb') as f:
                    for line in f:
                        if not line.endswith(b'\n'): break
                        if copy == 0: out.write(line); n += 1; continue
                        try: row = json.loads(line)
                        except ValueError: continue
                        if not isinstance(row, dict): continue
                        for field in ID_FIELDS:
                            if isinstance(row.get(field), str): row[field] = f'{row[field]}#{copy}'
                        out.write((json.dumps(row, sort_keys=True) + '\n').encode('utf-8')); n += 1
        counts[name] = n
    return counts


def measure(root: Path, scale: int, args: argparse.Namespace, tag: str) -> dict:
    size = args.batch_size
    cold_s, cold_rss, _ = run_cli(root, 'batch', json.dumps(batch_records(f'{tag}-warm', size)))
    batch_t = []; batch_rss = []
    for i in range(args.repeat):
        elapsed, rss, _ = run_cli(root, 'batch', json.dumps(batch_records(f'{tag}-{i}', size)))
        batch_t.append(elapsed); batch_rss.append(rss)
    dash_t = []; dash_rss = []
    for _ in range(args.repeat):
        elapsed, rss, _ = run_cli(root, 'dashboard'); dash_t.append(elapsed); dash_rss.append(rss)
    single_t = []; single_rss = []; single_spawns = 0
    for i in range(args.repeat):
        total = 0.0
        for record in batch_records(f'{tag}-single-{i}', size):
            stream = record.pop('stream')
            if stream == 'event':
                elapsed, rss, _ = run_cli(root, 'event', record.pop('event'), json.dumps(record))
            else:
                elapsed, rss, _ = run_cli(root, stream, json.dumps(record))
            total += elapsed; single_rss.append(rss); single_spawns += 1
        single_t.append(total)
    med_batch = statistics.median(batch_t); med_dash = statistics.median(dash_t); med_single = statistics.median(single_t)
    return {
        'scale': f'{scale}x', 'rows': {n: sum(1 for _ in (root / n).open('rb')) for n in STREAMS},
        'bytes': {n: (root / n).stat().st_size for n in STREAMS},
        'cold_first_batch': {'elapsed_s': round(cold_s, 3), 'peak_rss_mib': round(rss_mib(cold_rss), 1)},
        'batch': {'subprocesses': 1, 'records': size, 'median_s': round(med_batch, 4), 'peak_rss_mib': round(rss_mib(max(batch_rss)), 1),
                  'records_per_s': round(size / med_batch, 2)},
        'dashboard': {'subprocesses': 1, 'median_s': round(med_dash, 4), 'peak_rss_mib': round(rss_mib(max(dash_rss)), 1),
                      'refreshes_per_s': round(1 / med_dash, 2)},
        'per_record_legacy': {'subprocesses': size, 'records': size, 'median_s': round(med_single, 4),
                              'peak_rss_mib': round(rss_mib(max(single_rss)), 1), 'records_per_s': round(size / med_single, 2)},
        'total_subprocesses': 1 + 2 * args.repeat + single_spawns,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--runs', type=int, default=500, help='synthetic runs at 1x (~12 events, ~12 metrics, ~5 outcomes each)')
    ap.add_argument('--scales', default='1,2,4'); ap.add_argument('--repeat', type=int, default=5)
    ap.add_argument('--batch-size', type=int, default=5); ap.add_argument('--seed', type=int, default=7)
    ap.add_argument('--source', type=Path, default=None, help='copy this root\'s JSONL streams into the temp fixture instead of synthesizing')
    ap.add_argument('--json', action='store_true', help='print one JSON document instead of a table')
    args = ap.parse_args()
    scales = [int(s) for s in args.scales.split(',') if s.strip()]
    results = []
    with tempfile.TemporaryDirectory(prefix='orchestrator-bench-') as tmp:
        for scale in scales:
            root = Path(tmp, f'{scale}x')
            if args.source is not None: copy_fixture(args.source.expanduser(), root, scale)
            else: write_synthetic_history(root, runs=args.runs * scale, seed=args.seed)
            results.append(measure(root, scale, args, tag=f'{scale}x'))
            shutil.rmtree(root, ignore_errors=True)
    meta = {'python': sys.version.split()[0], 'platform': sys.platform, 'repeat': args.repeat, 'batch_size': args.batch_size,
            'fixture': 'copy of ' + str(args.source) if args.source else f'synthetic runs={args.runs} seed={args.seed}'}
    if args.json:
        print(json.dumps({'meta': meta, 'results': results}, indent=2)); return
    print(f"# refresh benchmark — {meta['fixture']} — python {meta['python']} {meta['platform']} — repeat={args.repeat} batch={args.batch_size}")
    print('| scale | metrics rows / MB | op | subprocesses | median s | peak child RSS MiB | throughput |')
    print('|---|---:|---|---:|---:|---:|---:|')
    for r in results:
        rows = f"{r['rows']['metrics.jsonl']} / {r['bytes']['metrics.jsonl'] / 1e6:.1f}"
        b, d, s = r['batch'], r['dashboard'], r['per_record_legacy']
        print(f"| {r['scale']} | {rows} | batch ({b['records']} rec) | {b['subprocesses']} | {b['median_s']:.3f} | {b['peak_rss_mib']:.1f} | {b['records_per_s']:.1f} rec/s |")
        print(f"| {r['scale']} | {rows} | dashboard | {d['subprocesses']} | {d['median_s']:.3f} | {d['peak_rss_mib']:.1f} | {d['refreshes_per_s']:.2f} refresh/s |")
        print(f"| {r['scale']} | {rows} | per-record legacy ({s['records']} rec) | {s['subprocesses']} | {s['median_s']:.3f} | {s['peak_rss_mib']:.1f} | {s['records_per_s']:.1f} rec/s |")
        print(f"| {r['scale']} | {rows} | cold first batch | 1 | {r['cold_first_batch']['elapsed_s']:.3f} | {r['cold_first_batch']['peak_rss_mib']:.1f} | — |")


if __name__ == '__main__':
    main()

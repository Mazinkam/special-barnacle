"""Before/after benchmark for the orchestrator refresh path on synthetic 1x/2x/4x fixtures.

    PYTHONDONTWRITEBYTECODE=1 python3 -B scripts/benchmark_refresh.py [--runs 500] [--repeat 5] [--scales 1,2,4] [--json]

Never reads live state: every fixture is written into a fresh temporary directory by
`tests.test_dashboard_refresh.write_synthetic_history` (`--source ROOT` copies the three JSONL
streams of an existing root into the temp directory instead and replicates them for 2x/4x with
re-suffixed identifiers). For each scale the script:

1. warms the fixture with one CLI `batch` call (cold record-index derivation + full ledger
   replay; reported as `cold_first_batch`, not included in the medians);
2. measures `--repeat` CLI `batch` invocations of a `--batch-size`-record batch (durable append +
   incremental ledger + dashboard) and `--repeat` CLI `dashboard` invocations;
3. for comparison, measures writing the same records through the legacy one-record commands
   (`event`/`metric`/`outcome`), i.e. one subprocess per record.

Per measured operation it prints the subprocess count, median elapsed seconds (spawn to reap),
peak child RSS, throughput, and the bytes the child actually read and wrote:

* **logical** bytes are counted inside the child by `instrumented_argv`: every file object the
  program opens (`io.open`/`open`/`Path.open`/`os.fdopen`) gets a counting raw layer, and
  `os.read`/`os.write`/`os.pread`/`os.pwrite` are wrapped. That is the program's own data I/O —
  streams, ledger, checkpoint, dashboard — and excludes interpreter start-up (module loading goes
  through `_io.open_code`), the child's stdout/stderr, and sqlite3's own file I/O (C library).
* **physical** bytes are what the OS says reached the disk for the process: Linux `/proc/self/io`
  `read_bytes`/`write_bytes` (which also yields kernel-counted logical `rchar`/`wchar` over *all*
  descriptors, reported as `kernel_logical`), macOS `proc_pid_rusage` `ri_diskio_bytesread/
  byteswritten`. Page-cache hits make physical reads much smaller than logical reads; that gap is
  the point of reporting both. `null` means the platform offers no per-process source.

Each child is reaped with `os.wait4`, so `peak_rss_mib` is that child's own `ru_maxrss` (MiB on
macOS bytes / Linux KiB), and its stdout/stderr go to temporary files, never pipes: a chatty child
cannot block on a full pipe while the parent waits. Run before and after a change with the same
arguments; fixture sizes are reported separately (`fixture_bytes`) and are not a measurement.
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
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

STREAMS = ('events.jsonl', 'metrics.jsonl', 'outcomes.jsonl')
ID_FIELDS = ('record_id', 'run_id', 'task_id', 'session_id', 'decision_id')
IO_REPORT_ENV = 'ORCHESTRATOR_BENCH_IO_REPORT'
LOGICAL_SOURCE = 'python file objects + os.read/os.write in the child (excludes interpreter start-up, stdio and sqlite3)'

# Prepended to every instrumented child's `-c` program. Pure standard library, runs before the
# program under test, writes its report at exit to the path in $ORCHESTRATOR_BENCH_IO_REPORT.
_INSTRUMENT = r'''
import atexit, builtins, io, json, os, sys
_counts = {'read': 0, 'write': 0}
_real_open = io.open

class _CountingFileIO(io.FileIO):
    """The raw layer io.open would have built, counting bytes as the buffered layers pull/push them."""
    def readinto(self, b):
        n = super().readinto(b)
        if n: _counts['read'] += n
        return n
    def read(self, size=-1):
        data = super().read(size)
        if data: _counts['read'] += len(data)
        return data
    def readall(self):
        data = super().readall()
        if data: _counts['read'] += len(data)
        return data
    def write(self, b):
        n = super().write(b)
        if n: _counts['write'] += n
        return n

def _open(file, mode='r', buffering=-1, encoding=None, errors=None, newline=None, closefd=True, opener=None):
    # io.open's raw -> buffered -> text layering, with the counting raw layer underneath.
    modes = set(mode)
    binary = 'b' in modes
    if binary and 't' in modes: raise ValueError("can't have text and binary mode at once")
    creating, reading, writing, appending, updating = ('x' in modes), ('r' in modes), ('w' in modes), ('a' in modes), ('+' in modes)
    raw_mode = ('x' if creating else '') + ('r' if reading else '') + ('w' if writing else '') + ('a' if appending else '') + ('+' if updating else '')
    raw = _CountingFileIO(file, raw_mode, closefd, opener=opener)
    try:
        line_buffering = False
        if buffering == 1 or (buffering < 0 and raw.isatty()): buffering = -1; line_buffering = True
        if buffering < 0:
            buffering = io.DEFAULT_BUFFER_SIZE
            try: block = os.fstat(raw.fileno()).st_blksize
            except (OSError, AttributeError): pass
            else:
                if block > 1: buffering = block
        if buffering == 0:
            if binary: return raw
            raise ValueError("can't have unbuffered text I/O")
        if updating: buffer = io.BufferedRandom(raw, buffering)
        elif creating or writing or appending: buffer = io.BufferedWriter(raw, buffering)
        else: buffer = io.BufferedReader(raw, buffering)
        if binary: return buffer
        text = io.TextIOWrapper(buffer, encoding, errors, newline, line_buffering); text.mode = mode
        return text
    except Exception:
        raw.close(); raise

def _counted(fn, key):
    def wrapper(*args, **kwargs):
        result = fn(*args, **kwargs)
        n = result if isinstance(result, int) else len(result)
        if n > 0: _counts[key] += n
        return result
    return wrapper

io.open = builtins.open = _open
for _name, _key in (('read', 'read'), ('pread', 'read'), ('readv', 'read'), ('write', 'write'), ('pwrite', 'write'), ('writev', 'write')):
    if hasattr(os, _name): setattr(os, _name, _counted(getattr(os, _name), _key))

def _kernel_view():
    """The OS's own per-process counters: physical bytes everywhere it exists, kernel logical bytes on Linux."""
    if sys.platform.startswith('linux'):
        try:
            with _real_open('/proc/self/io') as f:
                fields = {k.strip(): int(v) for k, v in (line.split(':', 1) for line in f if ':' in line)}
            return {'physical': {'read_bytes': fields['read_bytes'], 'write_bytes': fields['write_bytes'], 'source': '/proc/self/io read_bytes/write_bytes'},
                    'kernel_logical': {'read_bytes': fields['rchar'], 'write_bytes': fields['wchar'], 'source': '/proc/self/io rchar/wchar (all descriptors, incl. stdio and start-up)'}}
        except (OSError, KeyError, ValueError): return {}
    if sys.platform == 'darwin':
        try:
            import ctypes
            class RusageInfoV2(ctypes.Structure):
                _fields_ = [('ri_uuid', ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in (
                    'ri_user_time', 'ri_system_time', 'ri_pkg_idle_wkups', 'ri_interrupt_wkups', 'ri_pageins', 'ri_wired_size',
                    'ri_resident_size', 'ri_phys_footprint', 'ri_proc_start_abstime', 'ri_proc_exit_abstime', 'ri_child_user_time',
                    'ri_child_system_time', 'ri_child_pkg_idle_wkups', 'ri_child_interrupt_wkups', 'ri_child_pageins',
                    'ri_child_elapsed_abstime', 'ri_diskio_bytesread', 'ri_diskio_byteswritten')]
            info = RusageInfoV2()
            if ctypes.CDLL('/usr/lib/libproc.dylib').proc_pid_rusage(os.getpid(), 2, ctypes.byref(info)) != 0: return {}
            return {'physical': {'read_bytes': int(info.ri_diskio_bytesread), 'write_bytes': int(info.ri_diskio_byteswritten),
                                 'source': 'proc_pid_rusage(RUSAGE_INFO_V2) ri_diskio_bytesread/byteswritten'}}
        except (OSError, AttributeError): return {}
    return {}

def _report():
    path = os.environ.get('ORCHESTRATOR_BENCH_IO_REPORT')
    if not path: return
    report = {'python_file_io': {'read_bytes': _counts['read'], 'write_bytes': _counts['write']}, **_kernel_view()}
    try:
        with _real_open(path, 'w') as f: json.dump(report, f)
    except OSError: pass
atexit.register(_report)
'''

_RUN_CLI = r'''
import sys
sys.argv = ['orchestrator', *sys.argv[1:]]
from orchestrator import cli
cli.main()
'''


@dataclass
class ChildRun:
    argv: list
    returncode: int
    elapsed_s: float          # spawn to reap, i.e. what one more subprocess costs the caller
    ru_maxrss: int            # the child's own high-water mark (os.wait4)
    ru_inblock: int           # rusage block counts: populated on Linux, always 0 on macOS
    ru_oublock: int
    stdout: str
    stderr: str
    io: dict | None           # the child's I/O report; None when the child was not instrumented or died before completing it


def rss_mib(ru_maxrss: int) -> float:
    return ru_maxrss / (1024 ** 2 if sys.platform == 'darwin' else 1024)


def cli_env(root: Path) -> dict[str, str]:
    return {**os.environ, 'CODING_AGENT_ORCHESTRATOR_HOME': str(root), 'CODING_AGENT_RUNTIME': 'benchmark',
            'CODING_AGENT_REPOSITORY': '/work/forge', 'PYTHONPATH': str(REPO), 'PYTHONDONTWRITEBYTECODE': '1'}


def instrumented_argv(program: str, *args: str) -> list[str]:
    """argv for a child that runs `program` (Python source) with I/O counting installed first."""
    return [sys.executable, '-B', '-c', _INSTRUMENT + program, *args]


def cli_argv(*args: str) -> list[str]:
    return instrumented_argv(_RUN_CLI, *args)


def run_child(argv: list[str], *, env: dict[str, str], cwd: str | None = None, stdin: str | None = None) -> ChildRun:
    """Spawn `argv`, reap it with os.wait4 and collect its output and I/O report.

    stdin/stdout/stderr are temporary files rather than pipes, so the child can never block on a
    full pipe while this process is blocked in wait4 (and the parent never has to read while
    waiting). The I/O report path is handed to the child through $ORCHESTRATOR_BENCH_IO_REPORT and
    lives in the same private temporary directory, never in the state root under test.
    """
    with tempfile.TemporaryDirectory(prefix='orchestrator-bench-child-') as tmp:
        report = Path(tmp, 'io.json')
        with open(Path(tmp, 'stdin'), 'w+b') as inp, open(Path(tmp, 'stdout'), 'w+b') as out, open(Path(tmp, 'stderr'), 'w+b') as err:
            if stdin is not None: inp.write(stdin.encode('utf-8')); inp.flush(); inp.seek(0)
            start = time.perf_counter()
            proc = subprocess.Popen(argv, stdin=inp if stdin is not None else subprocess.DEVNULL, stdout=out, stderr=err,
                                    env={**env, IO_REPORT_ENV: str(report)}, cwd=cwd)
            _, status, usage = os.wait4(proc.pid, 0)
            elapsed = time.perf_counter() - start
            proc.returncode = code = os.waitstatus_to_exitcode(status)  # tell Popen it is reaped; no second waitpid
            out.seek(0); err.seek(0)
            stdout = out.read().decode('utf-8', 'replace'); stderr = err.read().decode('utf-8', 'replace')
        io_report = _load_io_report(report)
    return ChildRun(list(argv), code, elapsed, usage.ru_maxrss, usage.ru_inblock, usage.ru_oublock, stdout, stderr, io_report)


def _load_io_report(path: Path) -> dict | None:
    """The child's report, or None when it is missing, truncated (child died mid-write) or not an object.

    A child that crashes while `_report` is writing leaves an unparseable file; that must not turn
    into a decode error in the parent, which would hide the child's non-zero exit code.
    """
    try:
        loaded = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    return loaded if isinstance(loaded, dict) else None


def run_cli(root: Path, *args: str, stdin: str | None = None) -> ChildRun:
    """Run one instrumented CLI subprocess against `root`; a non-zero exit aborts the benchmark."""
    run = run_child(cli_argv(*args), env=cli_env(root), cwd=str(REPO), stdin=stdin)
    if run.returncode != 0:
        raise SystemExit(f'CLI {args[0]} failed ({run.returncode}):\n{run.stdout}\n{run.stderr}')
    return run


def io_summary(groups: list[list[ChildRun]]) -> dict:
    """Median over `groups` of the bytes each group of children moved (a group is one operation).

    Logical and physical are reported side by side and never substituted for one another; each
    carries the name of its source. A group's total for a section exists only when *every* child in
    the group reported that section: a group with a silent child (no report, truncated report, or a
    platform without that source) is incomplete and contributes nothing, so a two-child operation is
    never presented as the bytes of its one reporting child. The median is over the complete groups;
    `groups`/`complete_groups` give the count and `partial` is True when any group was dropped. A
    section is None when no group reported it completely.
    """
    def total(group: list[ChildRun], section: str) -> tuple[int, int] | None:
        if not group or any(not run.io or not isinstance(run.io.get(section), dict) for run in group): return None
        return sum(run.io[section]['read_bytes'] for run in group), sum(run.io[section]['write_bytes'] for run in group)

    def section(name: str, default_source: str | None = None) -> dict | None:
        totals = [t for t in (total(g, name) for g in groups) if t is not None]
        if not totals: return None
        source = default_source or next((run.io[name].get('source') for g in groups for run in g if run.io and isinstance(run.io.get(name), dict)), None)
        return {'read_bytes': int(statistics.median(r for r, _ in totals)), 'write_bytes': int(statistics.median(w for _, w in totals)),
                'source': source, 'groups': len(groups), 'complete_groups': len(totals), 'partial': len(totals) < len(groups)}

    return {'logical': section('python_file_io', LOGICAL_SOURCE), 'kernel_logical': section('kernel_logical'), 'physical': section('physical'),
            'rusage_blocks': {'in': max((run.ru_inblock for g in groups for run in g), default=0),
                              'out': max((run.ru_oublock for g in groups for run in g), default=0), 'source': 'os.wait4 ru_inblock/ru_oublock (0 on macOS)'}}


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
    cold = run_cli(root, 'batch', json.dumps(batch_records(f'{tag}-warm', size)))
    batch = [run_cli(root, 'batch', json.dumps(batch_records(f'{tag}-{i}', size))) for i in range(args.repeat)]
    dash = [run_cli(root, 'dashboard') for _ in range(args.repeat)]
    single: list[list[ChildRun]] = []
    for i in range(args.repeat):
        group = []
        for record in batch_records(f'{tag}-single-{i}', size):
            stream = record.pop('stream')
            if stream == 'event': group.append(run_cli(root, 'event', record.pop('event'), json.dumps(record)))
            else: group.append(run_cli(root, stream, json.dumps(record)))
        single.append(group)
    med_batch = statistics.median(r.elapsed_s for r in batch); med_dash = statistics.median(r.elapsed_s for r in dash)
    med_single = statistics.median(sum(r.elapsed_s for r in group) for group in single)
    peak = lambda runs: round(rss_mib(max(r.ru_maxrss for r in runs)), 1)  # noqa: E731
    return {
        'scale': f'{scale}x', 'rows': {n: sum(1 for _ in (root / n).open('rb')) for n in STREAMS},
        'fixture_bytes': {n: (root / n).stat().st_size for n in STREAMS},  # size on disk, not a measurement of I/O
        'cold_first_batch': {'elapsed_s': round(cold.elapsed_s, 3), 'peak_rss_mib': peak([cold]), 'io': io_summary([[cold]])},
        'batch': {'subprocesses': 1, 'records': size, 'median_s': round(med_batch, 4), 'peak_rss_mib': peak(batch),
                  'records_per_s': round(size / med_batch, 2), 'io': io_summary([[r] for r in batch])},
        'dashboard': {'subprocesses': 1, 'median_s': round(med_dash, 4), 'peak_rss_mib': peak(dash),
                      'refreshes_per_s': round(1 / med_dash, 2), 'io': io_summary([[r] for r in dash])},
        'per_record_legacy': {'subprocesses': size, 'records': size, 'median_s': round(med_single, 4),
                              'peak_rss_mib': peak([r for group in single for r in group]), 'records_per_s': round(size / med_single, 2),
                              'io': io_summary(single)},
        'total_subprocesses': 1 + 2 * args.repeat + sum(len(group) for group in single),
    }


def _mib(n: int | None) -> str:
    return '—' if n is None else f'{n / 2 ** 20:.2f}'


def _io_cells(io: dict) -> str:
    def cell(section: dict | None, key: str) -> str:
        if section is None: return '—'
        return _mib(section[key]) + ('*' if section.get('partial') else '')

    logical, physical = io['logical'], io['physical']
    return (f"{cell(logical, 'read_bytes')} / {cell(logical, 'write_bytes')} | "
            f"{cell(physical, 'read_bytes')} / {cell(physical, 'write_bytes')}")


def main() -> None:
    from tests.test_dashboard_refresh import write_synthetic_history  # lazy: children and tests must not pay for it

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
            'fixture': 'copy of ' + str(args.source) if args.source else f'synthetic runs={args.runs} seed={args.seed}',
            'io': {'logical': LOGICAL_SOURCE, 'physical': next((r['batch']['io']['physical']['source'] for r in results if r['batch']['io']['physical']), None)}}
    if args.json:
        print(json.dumps({'meta': meta, 'results': results}, indent=2)); return
    print(f"# refresh benchmark — {meta['fixture']} — python {meta['python']} {meta['platform']} — repeat={args.repeat} batch={args.batch_size}")
    print(f"# logical bytes: {meta['io']['logical']}; physical bytes: {meta['io']['physical'] or 'unavailable on this platform'}")
    print('# * = partial: some repetitions had a child without a complete I/O report and were excluded from that median')
    print('| scale | metrics rows / fixture MB | op | subprocesses | median s | peak child RSS MiB | throughput | logical MiB read / written | physical MiB read / written |')
    print('|---|---:|---|---:|---:|---:|---:|---:|---:|')
    for r in results:
        rows = f"{r['rows']['metrics.jsonl']} / {r['fixture_bytes']['metrics.jsonl'] / 1e6:.1f}"
        b, d, s, c = r['batch'], r['dashboard'], r['per_record_legacy'], r['cold_first_batch']
        print(f"| {r['scale']} | {rows} | batch ({b['records']} rec) | {b['subprocesses']} | {b['median_s']:.3f} | {b['peak_rss_mib']:.1f} | {b['records_per_s']:.1f} rec/s | {_io_cells(b['io'])} |")
        print(f"| {r['scale']} | {rows} | dashboard | {d['subprocesses']} | {d['median_s']:.3f} | {d['peak_rss_mib']:.1f} | {d['refreshes_per_s']:.2f} refresh/s | {_io_cells(d['io'])} |")
        print(f"| {r['scale']} | {rows} | per-record legacy ({s['records']} rec) | {s['subprocesses']} | {s['median_s']:.3f} | {s['peak_rss_mib']:.1f} | {s['records_per_s']:.1f} rec/s | {_io_cells(s['io'])} |")
        print(f"| {r['scale']} | {rows} | cold first batch | 1 | {c['elapsed_s']:.3f} | {c['peak_rss_mib']:.1f} | — | {_io_cells(c['io'])} |")


if __name__ == '__main__':
    main()
